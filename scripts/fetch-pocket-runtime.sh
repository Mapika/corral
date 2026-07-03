#!/usr/bin/env bash
# Build the Play-compliant pocket runtime for the Android app (adapted from the proven
# spike/pocket-probe recipe).
#
# Downloads Termux aarch64 packages (node, ripgrep, bash + transitive libs), plus the Claude Code
# linux-arm64-musl binary and Alpine's musl loader, and repackages every executable/library as a
# lib*.so under src-tauri/pocket/runtime/jniLibs/arm64-v8a — CI copies that into the generated
# Android project so the OS extracts them to nativeLibraryDir, the only location a targetSdk 29+
# app may exec() from. Names that aren't already lib*.so get mangled (node -> libnode_exec.so,
# libssl.so.3 -> libssl_so_3.so); the original->packaged mapping goes to runtime-map.txt, packed
# into the backend payload (prepare-pocket.mjs), and the app recreates the original names as
# symlinks at first run.
set -euo pipefail

REPO=https://packages.termux.dev/apt/termux-main
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RT="$ROOT/src-tauri/pocket/runtime"
JNI="$RT/jniLibs/arm64-v8a"
WORK="$ROOT/src-tauri/pocket/.runtime-work"
# No npm: the backend needs no package installs at runtime, and claude is the musl binary.
PKGS=(nodejs-lts ripgrep bash)
# data-only / termux-specific packages we never need; "nodejs" is skipped so nothing drags in
# the non-LTS node via a "nodejs | nodejs-lts" alternative.
SKIP="termux-tools termux-am termux-exec termux-keyring termux-licenses ca-certificates resolv-conf command-not-found dpkg nodejs"

rm -rf "$RT" "$WORK"
mkdir -p "$JNI" "$WORK/x"

curl -fsSL "$REPO/dists/stable/main/binary-aarch64/Packages" -o "$WORK/Packages"

field() { # <pkg> <field> -> value
  awk -v RS= -v p="$1" '$1=="Package:" && $2==p {print; exit}' "$WORK/Packages" \
    | sed -n "s/^$2: //p"
}

# --- resolve + fetch (BFS over Depends) ---------------------------------
queue=("${PKGS[@]}")
declare -A seen
while ((${#queue[@]})); do
  pkg="${queue[0]}"; queue=("${queue[@]:1}")
  [[ -n "${seen[$pkg]:-}" ]] && continue
  seen[$pkg]=1
  if grep -qw "$pkg" <<<"$SKIP"; then echo "skip:  $pkg"; continue; fi
  fn="$(field "$pkg" Filename)"
  if [[ -z "$fn" ]]; then echo "WARN: package '$pkg' not found in index"; continue; fi
  echo "fetch: $pkg  ($fn)"
  curl -fsSL "$REPO/$fn" -o "$WORK/$pkg.deb"
  mkdir -p "$WORK/x/$pkg"
  dpkg-deb -x "$WORK/$pkg.deb" "$WORK/x/$pkg"
  while IFS= read -r dep; do
    [[ -n "$dep" ]] && queue+=("$dep")
  done < <(field "$pkg" Depends | tr ',' '\n' | sed 's/([^)]*)//g; s/|.*//; s/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d')
done

MAP="$RT/runtime-map.txt"
: >"$MAP"

mangle() { # produce a lib*.so name from an arbitrary basename
  local n="$1"
  if [[ "$n" == lib*.so ]]; then echo "$n"; return; fi
  n="$(echo "$n" | sed 's/[^A-Za-z0-9_]/_/g').so"
  [[ "$n" == lib* ]] || n="lib$n"
  echo "$n"
}

# --- libraries: usr/lib/*.so* (follow symlink chains) --------------------
for d in "$WORK"/x/*/data/data/com.termux/files/usr/lib; do
  [[ -d "$d" ]] || continue
  for f in "$d"/*.so*; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"
    real="$(readlink -f "$f")"
    packed="$(mangle "$(basename "$real")")"
    if [[ ! -e "$JNI/$packed" ]]; then cp "$real" "$JNI/$packed"; fi
    echo "lib $base $packed" >>"$MAP"
  done
done

# --- executables: ELF files in usr/bin -----------------------------------
for d in "$WORK"/x/*/data/data/com.termux/files/usr/bin; do
  [[ -d "$d" ]] || continue
  for f in "$d"/*; do
    [[ -f "$f" && ! -L "$f" ]] || continue
    file -b "$f" | grep -q ELF || continue
    base="$(basename "$f")"
    packed="$(mangle "${base}_exec")"
    cp "$f" "$JNI/$packed"
    echo "bin $base $packed" >>"$MAP"
  done
done

# --- claude code: native musl binary + musl loader ------------------------
# The npm package is a platform-binary installer these days; none of its optionalDeps match
# android, so we ship the linux-arm64-musl binary in the APK and exec it through Alpine's musl
# loader (its PT_INTERP /lib/ld-musl-* does not exist on Android).
CLAUDE_TGZ_URL="$(curl -fsSL https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64-musl/latest | jq -r .dist.tarball)"
echo "fetch: claude-code ($CLAUDE_TGZ_URL)"
curl -fsSL "$CLAUDE_TGZ_URL" -o "$WORK/claude-musl.tgz"
tar -xzf "$WORK/claude-musl.tgz" -C "$WORK" package/claude
cp "$WORK/package/claude" "$JNI/libclaude_exec.so"
echo "bin claude libclaude_exec.so" >>"$MAP"

ALPINE_BASE=https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64
ALPINE_FILE="$(curl -fsSL "$ALPINE_BASE/latest-releases.yaml" | grep -m1 'file: alpine-minirootfs' | awk '{print $2}')"
echo "fetch: musl loader ($ALPINE_FILE)"
curl -fsSL "$ALPINE_BASE/$ALPINE_FILE" -o "$WORK/alpine.tar.gz"
tar -xzf "$WORK/alpine.tar.gz" -C "$WORK" --wildcards '*ld-musl-aarch64.so.1'
cp "$WORK"/lib/ld-musl-aarch64.so.1 "$JNI/libldmusl_exec.so"
echo "bin ld-musl libldmusl_exec.so" >>"$MAP"

sort -o "$MAP" "$MAP"
rm -rf "$WORK"
echo
echo "== runtime-map.txt =="
cat "$MAP"
echo
echo "== jniLibs ($(du -sh "$JNI" | cut -f1)) =="
ls -la "$JNI"
