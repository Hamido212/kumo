// The Slint UI, only for the Mac: on Windows this crate just renders test frames.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // the shared library.rs lists shader wallpapers only where they are compiled (the Windows
    // build sets this cfg); this renderer has none yet, so the Mac never lists them
    println!("cargo::rustc-check-cfg=cfg(shader_wallpapers)");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let config = slint_build::CompilerConfiguration::new()
        .with_style("fluent".into())
        .with_bundled_translations("../lang")
        .with_default_translation_context(slint_build::DefaultTranslationContext::None);
    slint_build::compile_with_config("ui/app.slint", config).expect("Slint UI failed to compile");
    println!("cargo:rerun-if-changed=../lang");
}
