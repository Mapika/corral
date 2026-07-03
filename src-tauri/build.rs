fn main() {
  // Stage the pocket backend payload where include_bytes! can reach it (android's pocket module).
  // Slim/desktop builds get an empty payload so compilation never requires prepare-pocket.mjs;
  // pocket.rs refuses to extract an empty payload and pocket_available() stays false without the
  // jniLibs runtime anyway.
  let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
  let payload = std::path::Path::new("pocket/payload.tar.gz");
  if payload.exists() {
    std::fs::copy(payload, out.join("pocket-payload.tar.gz")).unwrap();
    std::fs::copy("pocket/payload.sha", out.join("pocket-payload.sha")).unwrap();
  } else {
    std::fs::write(out.join("pocket-payload.tar.gz"), []).unwrap();
    std::fs::write(out.join("pocket-payload.sha"), "none").unwrap();
  }
  println!("cargo:rerun-if-changed=pocket/payload.tar.gz");
  println!("cargo:rerun-if-changed=pocket/payload.sha");
  tauri_build::build()
}
