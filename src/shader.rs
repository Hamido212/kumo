//! Shader wallpapers ("animations"): pictures drawn entirely by one full-screen pixel shader,
//! `src/fx/<id>.hlsl`, compiled to bytecode by build.rs. No meshes and no textures: every frame
//! the shader gets one small constant buffer (time, size, time of day, colour style) and fills a
//! 10-bit target below screen size, which the post pass scales to each screen and dithers.
//!
//! What one costs: a pixel shader of a few kB, a 48-byte constant buffer and a 256 kB texture of
//! random bytes for the noise (made once, nothing is loaded). The render target belongs to the
//! engine and is freed with all others whenever nothing is drawn. The library entries (title,
//! thumbnail) are in library.rs.

use crate::config::{Settings, TimeMode};
use crate::gfx::{viewport, Gpu, Target};
use windows::core::Result;
use windows::Win32::Graphics::Direct3D::D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
use windows::Win32::Graphics::Direct3D11::*;

pub struct Effect {
    pub id: &'static str,
    code: &'static [u8],
    /// render resolution relative to the screen at the "High" setting: soft effects need fewer
    /// pixels than ones with fine lines or points
    pub scale: f32,
}

macro_rules! effect {
    ($id:literal, $scale:expr) => {
        Effect { id: $id, code: include_bytes!(concat!(env!("OUT_DIR"), "/fx-", $id, ".cso")), scale: $scale }
    };
}

/// Every shader wallpaper; library.rs lists the same ids.
pub static EFFECTS: &[Effect] = &[
    effect!("northern-lights", 0.6),
    effect!("neon-horizon", 0.8),
    effect!("nebula-drift", 0.6),
    effect!("midnight-silk", 0.5),
    effect!("star-drift", 0.75),
    effect!("ocean-swell", 0.6),
];

pub fn effect(id: &str) -> Option<&'static Effect> {
    EFFECTS.iter().find(|e| e.id == id)
}

/// The shader's clock wraps after this many seconds, so its f32 time never gets coarser than
/// half a millisecond. During the last FADE seconds before the wrap the picture fades into its
/// own continuation (the shader draws both), so the jump never shows.
pub const WRAP: f64 = 4096.0;
pub const FADE: f64 = 30.0;

/// Most pixels a shader wallpaper renders for one group of screens: a 4K screen gets the pixels
/// of a 1080p one, scaled up, because every pixel runs the whole effect.
pub const MAX_PIXELS: f32 = 1920.0 * 1080.0;

/// The longest step the clock takes in one frame: after any pause it goes on where it stopped.
pub const MAX_STEP: f32 = 0.25;

/// (seconds as the shader sees them, weight of the continuation) at animation time `t`.
pub fn shader_time(t: f64) -> (f32, f32) {
    let u = t.rem_euclid(WRAP);
    let f = ((u - (WRAP - FADE)) / FADE).clamp(0.0, 1.0);
    (u as f32, (f * f * (3.0 - 2.0 * f)) as f32)
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The light of an hour, smooth around the clock: [night 0..1, warm light of dawn and dusk 0..1,
/// height of the sun -1..1 (rises 6:30, highest 12:30, sets 18:30)].
pub fn daylight(hour: f32) -> [f32; 3] {
    let h = hour.rem_euclid(24.0);
    let night = if h < 12.0 { 1.0 - smooth(4.5, 7.0, h) } else { smooth(19.0, 21.5, h) };
    let bump = |c: f32, w: f32| (-((h - c) / w).powi(2)).exp();
    let warm = (bump(6.4, 0.9) + bump(18.7, 1.3)).min(1.0);
    let sun = (std::f32::consts::TAU * (h - 6.5) / 24.0).sin();
    [night, warm, sun]
}

/// Pixels to render for a group of screens of `w` x `h` at render quality `quality`.
pub fn render_size(w: u32, h: u32, quality: f32, effect_scale: f32) -> (u32, u32) {
    let mut k = (quality * effect_scale).clamp(0.25, 1.0);
    let pixels = w as f32 * h as f32;
    if pixels * k * k > MAX_PIXELS {
        k = (MAX_PIXELS / pixels).sqrt();
    }
    (((w as f32 * k).round() as u32).max(16), ((h as f32 * k).round() as u32).max(16))
}

/// Animation time and hour of day. Time only moves while the wallpaper is drawn, by the frames'
/// own steps, so it is the same for every screen and continues smoothly after a pause.
#[derive(Clone, Debug, Default)]
pub struct Clock {
    pub t: f64,
    pub hour: f32,
    lapse_hour: Option<f32>,
}

impl Clock {
    pub fn advance(&mut self, dt: f32, s: &Settings) {
        let dt = dt.clamp(0.0, MAX_STEP);
        self.t += dt as f64 * s.speed.clamp(0.1, 4.0) as f64;
        self.hour = match s.time {
            TimeMode::Real => crate::world::local_hour(),
            TimeMode::Fixed => s.hour,
            TimeMode::Lapse => {
                let h = self.lapse_hour.get_or_insert_with(crate::world::local_hour);
                *h = (*h + dt * s.lapse / 3600.0).rem_euclid(24.0);
                *h
            }
        };
    }

    /// Time-lapse starts again from the current time.
    pub fn reset_lapse(&mut self) {
        self.lapse_hour = None;
    }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FxCB {
    time: [f32; 4],
    res: [f32; 4],
    sky: [f32; 4],
}

/// Side of the noise texture.
pub const NOISE: u32 = 256;

/// The random bytes behind the shaders' noise (see src/fx/common.hlsl): the same every time.
pub fn noise_bytes() -> Vec<u8> {
    let mut rng = crate::world::Rng::new(0x6b756d6f);
    (0..NOISE * NOISE * 4).map(|_| (rng.next() * 256.0) as u8).collect()
}

/// A shader wallpaper on screen.
pub struct Animation {
    pub effect: &'static Effect,
    pub clock: Clock,
    style: u32,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    cb: ID3D11Buffer,
    noise: ID3D11ShaderResourceView,
    smp: ID3D11SamplerState,
    rs: ID3D11RasterizerState,
    ds: ID3D11DepthStencilState,
}

impl Animation {
    pub fn new(gpu: &Gpu, effect: &'static Effect) -> Result<Animation> {
        // 256 kB on the GPU, made once; the bytes on the CPU go right away
        let noise = crate::gfx::texture_bgra(gpu, &noise_bytes(), NOISE, NOISE)?;
        let desc = D3D11_SAMPLER_DESC {
            Filter: D3D11_FILTER_MIN_MAG_MIP_POINT,
            AddressU: D3D11_TEXTURE_ADDRESS_WRAP,
            AddressV: D3D11_TEXTURE_ADDRESS_WRAP,
            AddressW: D3D11_TEXTURE_ADDRESS_WRAP,
            ComparisonFunc: D3D11_COMPARISON_NEVER,
            MaxLOD: f32::MAX,
            ..Default::default()
        };
        let mut smp = None;
        unsafe { gpu.dev.CreateSamplerState(&desc, Some(&mut smp))? };
        Ok(Animation {
            effect,
            clock: Clock::default(),
            style: 0,
            vs: gpu.vertex_shader(include_bytes!(concat!(env!("OUT_DIR"), "/VSFull.cso")))?,
            ps: gpu.pixel_shader(effect.code)?,
            cb: gpu.constants::<FxCB>()?,
            noise,
            smp: smp.unwrap(),
            rs: gpu.raster(D3D11_CULL_NONE)?,
            ds: gpu.depth(false, false)?,
        })
    }

    pub fn update(&mut self, dt: f32, s: &Settings) {
        self.clock.advance(dt, s);
        self.style = s.style;
    }

    /// Pixels to render for screens of `w` x `h`.
    pub fn size_for(&self, w: u32, h: u32, quality: f32) -> (u32, u32) {
        render_size(w, h, quality, self.effect.scale)
    }

    /// Draws the current frame into a flat target.
    pub fn render(&self, gpu: &Gpu, target: &Target) {
        let (t, fade) = shader_time(self.clock.t);
        let [night, warm, sun] = daylight(self.clock.hour);
        let (w, h) = (target.w as f32, target.h as f32);
        gpu.upload(&self.cb, &[FxCB { time: [t, self.clock.hour, fade, WRAP as f32], res: [w, h, 1.0 / w, 1.0 / h], sky: [night, warm, sun, self.style as f32] }]);
        let c = &gpu.ctx;
        unsafe {
            c.OMSetRenderTargets(Some(&[Some(target.rtv.clone())]), None);
            c.RSSetViewports(Some(&[viewport(target.w, target.h)]));
            c.RSSetState(&self.rs);
            c.OMSetDepthStencilState(&self.ds, 0);
            c.OMSetBlendState(None, None, 0xffffffff);
            c.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            c.IASetInputLayout(None);
            c.VSSetShader(&self.vs, None);
            c.PSSetShader(&self.ps, None);
            c.PSSetConstantBuffers(0, Some(&[Some(self.cb.clone())]));
            c.PSSetShaderResources(0, Some(&[Some(self.noise.clone())]));
            c.PSSetSamplers(0, Some(&[Some(self.smp.clone())]));
            c.Draw(3, 0);
            c.PSSetShaderResources(0, Some(&[None]));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed(hour: f32) -> Settings {
        Settings { time: TimeMode::Fixed, hour, ..Settings::default() }
    }

    #[test]
    fn every_effect_is_in_the_library_and_back() {
        for e in EFFECTS {
            let item = crate::library::builtin_item(e.id).unwrap_or_else(|| panic!("{} is not in the library", e.id));
            assert_eq!(item.kind, crate::library::Kind::Shader);
            assert!(e.code.len() > 100 && e.scale > 0.2 && e.scale <= 1.0, "{}", e.id);
        }
        for item in crate::library::builtin_items().iter().filter(|i| i.kind == crate::library::Kind::Shader) {
            assert!(effect(&item.id).is_some(), "{} has no shader", item.id);
        }
    }

    #[test]
    fn time_goes_on_where_it_stopped() {
        let s = fixed(20.0);
        let mut c = Clock::default();
        for _ in 0..90 {
            c.advance(1.0 / 30.0, &s);
        }
        let before = c.t;
        assert!((before - 3.0).abs() < 1e-4);
        // the engine slept for an hour: the next frame is one short step later, not an hour
        c.advance(3600.0, &s);
        assert!(c.t - before <= MAX_STEP as f64 + 1e-9);
        // frame rates only change the step size, not where the animation is
        let (mut a, mut b) = (Clock::default(), Clock::default());
        (0..15).for_each(|_| a.advance(1.0 / 15.0, &s));
        (0..60).for_each(|_| b.advance(1.0 / 60.0, &s));
        assert!((a.t - b.t).abs() < 1e-5);
    }

    #[test]
    fn speed_changes_do_not_jump() {
        let mut c = Clock::default();
        c.advance(0.1, &fixed(12.0));
        let fast = Settings { speed: 2.0, ..fixed(12.0) };
        let before = c.t;
        c.advance(0.1, &fast);
        assert!((c.t - before - 0.2).abs() < 1e-6);
        assert_eq!(c.hour, 12.0);
    }

    #[test]
    fn the_wrap_is_hidden_by_the_fade() {
        // what the screen shows: the effect at u, mixed into the effect at u - WRAP
        let shown = |t: f64| {
            let (u, f) = shader_time(t);
            (u as f64, u as f64 - WRAP, f as f64)
        };
        for k in 1..4 {
            let at = k as f64 * WRAP;
            let (_, late, f) = shown(at - 1e-3);
            assert!(f > 0.999 && (late + 1e-3).abs() < 1e-2);
            let (early, _, f) = shown(at + 1e-3);
            assert!(f == 0.0 && (early - 1e-3).abs() < 1e-2);
        }
        assert_eq!(shown(100.0).2, 0.0);
        assert_eq!(shown(WRAP - FADE - 1.0).2, 0.0);
        // and the shader's f32 time stays fine-grained
        let (u, _) = shader_time(1e9 + 0.5);
        assert!(u < WRAP as f32 && (u - (1e9_f64 + 0.5).rem_euclid(WRAP) as f32).abs() < 1e-3);
    }

    #[test]
    fn daylight_is_smooth_around_the_clock() {
        let [night, warm, sun] = daylight(23.0);
        assert!(night > 0.99 && warm < 0.01 && sun < 0.0);
        let [night, warm, sun] = daylight(12.5);
        assert!(night == 0.0 && warm < 0.01 && sun > 0.99);
        assert!(daylight(18.7)[1] > 0.9 && daylight(6.4)[1] > 0.9);
        let mut last = daylight(0.0);
        for i in 1..=2400 {
            let now = daylight(i as f32 * 0.01);
            for k in 0..3 {
                assert!((now[k] - last[k]).abs() < 0.02, "jump at {}", i as f32 * 0.01);
                assert!((-1.0..=1.0).contains(&now[k]));
            }
            last = now;
        }
    }

    #[test]
    fn the_noise_is_the_same_every_time_and_evenly_spread() {
        let a = noise_bytes();
        assert_eq!(a.len(), (NOISE * NOISE * 4) as usize);
        assert!(a == noise_bytes());
        let mean = a.iter().map(|&b| b as f64).sum::<f64>() / a.len() as f64;
        assert!((mean - 127.5).abs() < 1.5, "{mean}");
        assert!(a.iter().any(|&b| b == 0) && a.iter().any(|&b| b == 255));
    }

    #[test]
    fn render_size_follows_quality_and_is_capped() {
        assert_eq!(render_size(1920, 1080, 1.0, 0.6), (1152, 648));
        assert_eq!(render_size(1920, 1080, 0.62, 0.6), (714, 402));
        // 4K renders no more pixels than 1080p
        let (w, h) = render_size(3840, 2160, 1.0, 1.0);
        assert!(w * h <= 1920 * 1080 + 4000 && (w as f32 / h as f32 - 16.0 / 9.0).abs() < 0.01);
        // supersampling is pointless for a shader
        assert_eq!(render_size(1280, 720, 2.0, 0.8), (1280, 720));
        assert_eq!(render_size(10, 10, 0.3, 0.3), (16, 16));
    }
}
