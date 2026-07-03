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

CURL=(curl -fsSL --retry 5 --retry-all-errors --retry-delay 2)
REPO=https://packages.termux.dev/apt/termux-main
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RT="$ROOT/src-tauri/pocket/runtime"
JNI="$RT/jniLibs/arm64-v8a"
WORK="$ROOT/src-tauri/pocket/.runtime-work"
# No npm: the backend needs no package installs at runtime, and claude is the musl binary.
# python(+pip): agents kept hitting "python: not found" — the ELF bits ride jniLibs like node,
# the stdlib tree ships as a data tarball (see below). ca-certificates is wanted DATA now
# (python's ssl needs a cert bundle; node bundles its own).
PKGS=(nodejs-lts ripgrep bash python python-pip)
# data-only / termux-specific packages we never need; "nodejs" is skipped so nothing drags in
# the non-LTS node via a "nodejs | nodejs-lts" alternative.
SKIP="termux-tools termux-am termux-exec termux-keyring termux-licenses resolv-conf command-not-found dpkg nodejs"

rm -rf "$RT" "$WORK"
mkdir -p "$JNI" "$WORK/x"

"${CURL[@]}" "$REPO/dists/stable/main/binary-aarch64/Packages" -o "$WORK/Packages"

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
  "${CURL[@]}" "$REPO/$fn" -o "$WORK/$pkg.deb"
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

# --- usr/bin symlinks (python -> python3.12): alias onto the target's packed ELF ----------
for d in "$WORK"/x/*/data/data/com.termux/files/usr/bin; do
  [[ -d "$d" ]] || continue
  for f in "$d"/*; do
    [[ -L "$f" ]] || continue
    real="$(readlink -f "$f")"
    [[ -f "$real" ]] || continue
    file -b "$real" | grep -q ELF || continue
    echo "bin $(basename "$f") $(mangle "$(basename "$real")_exec")" >>"$MAP"
  done
done

# --- python: extension modules ride jniLibs, the stdlib tree ships as data ----------------
# lib-dynload/*.so must live in nativeLibraryDir (W^X: dlopen of app-data files is blocked at
# targetSdk 29+); the app symlinks them back into the extracted tree per 'dyn' map lines (path
# relative to the extracted root). Everything else — pure-python stdlib, pip's site-packages,
# the TLS bundle — is plain data: packed as a fake lib*.so so it rides the same jniLibs channel
# with zero extra CI plumbing, and extracted to filesDir at first boot ('data <sha> <packed>').
PYDATA="$WORK/pydata"
mkdir -p "$PYDATA/usr/lib"
for d in "$WORK"/x/*/data/data/com.termux/files/usr; do
  [[ -d "$d" ]] || continue
  for py in "$d"/lib/python3*; do
    [[ -d "$py" ]] || continue
    cp -r "$py" "$PYDATA/usr/lib/"
  done
  if [[ -d "$d/etc" ]]; then mkdir -p "$PYDATA/usr/etc"; cp -rL "$d/etc/." "$PYDATA/usr/etc/" 2>/dev/null || true; fi
done
while IFS= read -r -d '' so; do
  rel="${so#"$PYDATA"/}"
  packed="$(mangle "$(basename "$so")")"
  cp "$so" "$JNI/$packed"
  rm "$so"
  echo "dyn $rel $packed" >>"$MAP"
done < <(find "$PYDATA/usr/lib" -path '*/lib-dynload/*.so' -print0 2>/dev/null)
if [[ -n "$(ls -A "$PYDATA/usr/lib" 2>/dev/null)" ]]; then
  tar -C "$PYDATA" -czf "$WORK/pocket-data.tar.gz" usr
  DATA_SHA="$(sha256sum "$WORK/pocket-data.tar.gz" | cut -d' ' -f1)"
  cp "$WORK/pocket-data.tar.gz" "$JNI/libpocketdata_tgz.so"
  echo "data $DATA_SHA libpocketdata_tgz.so" >>"$MAP"
fi

# --- system-tool shims: am/pm/dumpsys/content break under our LD_LIBRARY_PATH -------------
# The runtime env points LD_LIBRARY_PATH at the termux libs (node/claude need it), and system
# binaries inherit it — termux libc++ & co. shadow the system ones and the linker dies
# ("cannot locate symbol ... libunwindstack.so"). Each shim execs the system binary with a
# clean library path. They're shebang scripts riding jniLibs: nativeLibraryDir files are
# executable and the kernel's shebang handling doesn't care that the filename says .so.
for tool in am pm dumpsys content settings cmd service input; do
  shim="$JNI/lib${tool}_shim_exec.so"
  printf '#!/system/bin/sh\nunset LD_LIBRARY_PATH\nexec /system/bin/%s "$@"\n' "$tool" >"$shim"
  chmod 755 "$shim"
  echo "bin $tool lib${tool}_shim_exec.so" >>"$MAP"
done

# --- claude code: native musl binary + musl loader ------------------------
# The npm package is a platform-binary installer these days; none of its optionalDeps match
# android, so we ship the linux-arm64-musl binary in the APK and exec it through Alpine's musl
# loader (its PT_INTERP /lib/ld-musl-* does not exist on Android).
CLAUDE_TGZ_URL="$("${CURL[@]}" https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64-musl/latest | jq -r .dist.tarball)"
echo "fetch: claude-code ($CLAUDE_TGZ_URL)"
"${CURL[@]}" "$CLAUDE_TGZ_URL" -o "$WORK/claude-musl.tgz"
tar -xzf "$WORK/claude-musl.tgz" -C "$WORK" package/claude
cp "$WORK/package/claude" "$JNI/libclaude_exec.so"
echo "bin claude libclaude_exec.so" >>"$MAP"

ALPINE_BASE=https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/aarch64
ALPINE_FILE="$("${CURL[@]}" "$ALPINE_BASE/latest-releases.yaml" | grep -m1 'file: alpine-minirootfs' | awk '{print $2}')"
echo "fetch: musl loader ($ALPINE_FILE)"
"${CURL[@]}" "$ALPINE_BASE/$ALPINE_FILE" -o "$WORK/alpine.tar.gz"
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
