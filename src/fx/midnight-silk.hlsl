// Midnight Silk: slow folds of dark fabric with a soft sheen.
//
// The cloth is a height field of two sine folds bent by noise (domain warping). Its slope gives
// a normal, lit like fabric: a broad diffuse light from the upper right and a sheen along the
// crests. The folds drift and slowly change shape; nothing in it ever repeats exactly.

float3 silkBase() { return pick(float3(0.0015, 0.003, 0.012), float3(0.010, 0.0015, 0.004), float3(0.002, 0.004, 0.005)); }
float3 silkMid() { return pick(float3(0.008, 0.026, 0.085), float3(0.080, 0.010, 0.022), float3(0.014, 0.040, 0.046)); }
float3 silkSheen() { return pick(float3(0.26, 0.32, 0.62), float3(0.72, 0.38, 0.16), float3(0.24, 0.52, 0.52)); }

float folds(float2 p, float t) {
  float2 q = mul(float2x2(0.87, 0.5, -0.5, 0.87), p);
  float w1 = fbm3(q * 0.9 + float2(t * 0.016, -t * 0.010));
  float w2 = gnoise(q * 2.0 + float2(-t * 0.014, t * 0.009) + 4.0);
  // about three folds per screen height, bent by the noise, one wider swell across them
  float a = q.y * 19.0 + 7.0 * w1 + 2.0 * w2 + t * 0.12;
  float b = q.y * 7.0 - q.x * 2.5 + 4.0 * w1 - t * 0.06;
  return 0.55 * sin(a) + 0.45 * sin(b);
}

float3 effect(float2 p, float t) {
  float e = 1.5 * PX;
  float h = folds(p, t);
  float2 slope = float2(folds(p + float2(e, 0.0), t) - h, folds(p + float2(0.0, e), t) - h) / e;
  float3 n = normalize(float3(-slope * 0.045, 1.0));
  float3 l = normalize(float3(0.5, 0.6, 0.62));
  float diffuse = saturate(dot(n, l));
  float3 hv = normalize(l + float3(0.0, 0.0, 1.0));
  float nh = saturate(dot(n, hv));
  float sheen = pow(nh, 26.0) * 0.45 + pow(nh, 6.0) * 0.04;

  // the light falls off towards the lower left, where icons usually sit
  float light = lerp(0.3, 1.0, ss(-1.3, 0.9, p.x * 0.55 + p.y));
  float3 c = lerp(silkBase(), silkMid(), diffuse * diffuse) * light;
  c += silkSheen() * sheen * light * light;
  // deeper colour in the hollows between folds
  c += silkMid() * 0.25 * ss(0.1, -0.9, h) * light;

  c = daytint(c, 0.5, 0.2);
  return encode(tonemapHue(c * 1.15));
}
