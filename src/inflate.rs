//! Inflate (RFC 1951): unpacks the scenes that ship inside the program. A baked scene is about
//! 5 MB of vertices and shrinks to about 1 MB, so three more scenes cost the download 3 MB
//! instead of 15. Small rather than fast (one bit at a time, like zlib's `puff`), which is fine for
//! a few megabytes when a scene is first shown. No crate, and the same code on Windows and macOS.

const MAX_BITS: usize = 15;
const LEN_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA: [u32; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA: [u32; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/// the order in which a dynamic block stores the lengths of its code-length code
const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

type Res<T> = Result<T, &'static str>;

struct Bits<'a> {
    src: &'a [u8],
    pos: usize,
    buf: u32,
    count: u32,
}

impl Bits<'_> {
    /// The next `need` bits (at most 16), lowest first.
    fn take(&mut self, need: u32) -> Res<u32> {
        while self.count < need {
            let byte = *self.src.get(self.pos).ok_or("the packed data ends early")?;
            self.pos += 1;
            self.buf |= (byte as u32) << self.count;
            self.count += 8;
        }
        let value = self.buf & ((1 << need) - 1);
        self.buf >>= need;
        self.count -= need;
        Ok(value)
    }
}

/// A canonical Huffman code: how many codes there are of each length, and the symbols in order.
struct Huffman {
    count: [u16; MAX_BITS + 1],
    symbol: [u16; 288],
}

impl Huffman {
    fn new(lengths: &[u8]) -> Res<Huffman> {
        let mut h = Huffman { count: [0; MAX_BITS + 1], symbol: [0; 288] };
        for &l in lengths {
            h.count[l as usize] += 1;
        }
        // more codes than their lengths leave room for is damage; fewer is allowed
        let mut left = 1i32;
        for len in 1..=MAX_BITS {
            left = (left << 1) - h.count[len] as i32;
            if left < 0 {
                return Err("the packed data has a broken code");
            }
        }
        let mut offset = [0u16; MAX_BITS + 2];
        for len in 1..=MAX_BITS {
            offset[len + 1] = offset[len] + h.count[len];
        }
        for (sym, &l) in lengths.iter().enumerate() {
            if l != 0 {
                h.symbol[offset[l as usize] as usize] = sym as u16;
                offset[l as usize] += 1;
            }
        }
        Ok(h)
    }

    fn decode(&self, bits: &mut Bits) -> Res<usize> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for len in 1..=MAX_BITS {
            code |= bits.take(1)? as i32;
            let count = self.count[len] as i32;
            if code - count < first {
                return Ok(self.symbol[(index + code - first) as usize] as usize);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err("the packed data has an unknown code")
    }
}

/// One compressed block: literals and copies of earlier output until the end symbol.
fn block(bits: &mut Bits, out: &mut Vec<u8>, size: usize, lit: &Huffman, dist: &Huffman) -> Res<()> {
    loop {
        let sym = lit.decode(bits)?;
        if sym < 256 {
            out.push(sym as u8);
        } else if sym == 256 {
            return Ok(());
        } else {
            let s = sym - 257;
            if s >= LEN_BASE.len() {
                return Err("the packed data has a bad length");
            }
            let len = LEN_BASE[s] as usize + bits.take(LEN_EXTRA[s])? as usize;
            let d = dist.decode(bits)?;
            if d >= DIST_BASE.len() {
                return Err("the packed data has a bad distance");
            }
            let back = DIST_BASE[d] as usize + bits.take(DIST_EXTRA[d])? as usize;
            if back > out.len() {
                return Err("the packed data points before its start");
            }
            // byte by byte: a copy may overlap what it writes
            for _ in 0..len {
                out.push(out[out.len() - back]);
            }
        }
        if out.len() > size {
            return Err("the packed data is longer than it says");
        }
    }
}

fn stored(bits: &mut Bits, out: &mut Vec<u8>) -> Res<()> {
    // a stored block starts at the next whole byte
    (bits.buf, bits.count) = (0, 0);
    let head = bits.src.get(bits.pos..bits.pos + 4).ok_or("the packed data ends early")?;
    let len = u16::from_le_bytes([head[0], head[1]]);
    if len != !u16::from_le_bytes([head[2], head[3]]) {
        return Err("the packed data has a broken stored block");
    }
    let from = bits.pos + 4;
    out.extend_from_slice(bits.src.get(from..from + len as usize).ok_or("the packed data ends early")?);
    bits.pos = from + len as usize;
    Ok(())
}

fn fixed() -> Res<(Huffman, Huffman)> {
    let mut lengths = [8u8; 288];
    lengths[144..256].fill(9);
    lengths[256..280].fill(7);
    Ok((Huffman::new(&lengths)?, Huffman::new(&[5; 30])?))
}

fn dynamic(bits: &mut Bits) -> Res<(Huffman, Huffman)> {
    let nlen = bits.take(5)? as usize + 257;
    let ndist = bits.take(5)? as usize + 1;
    let ncode = bits.take(4)? as usize + 4;
    if nlen > 286 || ndist > 30 {
        return Err("the packed data has too many codes");
    }
    let mut lengths = [0u8; 286 + 30];
    for &slot in &ORDER[..ncode] {
        lengths[slot] = bits.take(3)? as u8;
    }
    let code = Huffman::new(&lengths[..19])?;
    lengths = [0; 286 + 30];
    let mut i = 0;
    while i < nlen + ndist {
        let sym = code.decode(bits)?;
        if sym < 16 {
            lengths[i] = sym as u8;
            i += 1;
            continue;
        }
        let (value, repeat) = match sym {
            16 if i == 0 => return Err("the packed data repeats nothing"),
            16 => (lengths[i - 1], 3 + bits.take(2)? as usize),
            17 => (0, 3 + bits.take(3)? as usize),
            _ => (0, 11 + bits.take(7)? as usize),
        };
        if i + repeat > nlen + ndist {
            return Err("the packed data has too many lengths");
        }
        lengths[i..i + repeat].fill(value);
        i += repeat;
    }
    if lengths[256] == 0 {
        return Err("the packed data has no end code");
    }
    Ok((Huffman::new(&lengths[..nlen])?, Huffman::new(&lengths[nlen..nlen + ndist])?))
}

/// Unpacks a raw deflate stream that must give exactly `size` bytes.
pub fn inflate(src: &[u8], size: usize) -> Res<Vec<u8>> {
    let mut bits = Bits { src, pos: 0, buf: 0, count: 0 };
    let mut out = Vec::with_capacity(size);
    loop {
        let last = bits.take(1)? == 1;
        match bits.take(2)? {
            0 => stored(&mut bits, &mut out)?,
            1 => {
                let (lit, dist) = fixed()?;
                block(&mut bits, &mut out, size, &lit, &dist)?
            }
            2 => {
                let (lit, dist) = dynamic(&mut bits)?;
                block(&mut bits, &mut out, size, &lit, &dist)?
            }
            _ => return Err("the packed data has an unknown block"),
        }
        if out.len() > size {
            return Err("the packed data is longer than it says");
        }
        if last {
            break;
        }
    }
    if out.len() == size {
        Ok(out)
    } else {
        Err("the packed data is shorter than it says")
    }
}

/// A packed file as `scenes/pack.mjs` writes it: the unpacked size (u32, little endian), then
/// the deflate stream.
pub fn unpack(packed: &[u8]) -> Res<Vec<u8>> {
    let (head, body) = packed.split_first_chunk::<4>().ok_or("the packed data ends early")?;
    inflate(body, u32::from_le_bytes(*head) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    // made with Python: zlib.compressobj(level, zlib.DEFLATED, -15)
    #[test]
    fn all_three_block_types() {
        // stored (level 0)
        assert_eq!(inflate(&hex("010b00f4ff6b756d6f207363656e6500"), 11).unwrap(), b"kumo scene ");
        // fixed codes, with a copy that overlaps itself
        assert_eq!(inflate(&hex("4b4cc4044900"), 21).unwrap(), b"aaaaaaaaaaaaaaaaaaaab");
        // dynamic codes
        let text: Vec<u8> = (0..400).flat_map(|i| format!("voxel {} of the pagoda garden; ", i % 7).into_bytes()).collect();
        let packed = hex(DYNAMIC);
        assert_eq!(inflate(&packed, text.len()).unwrap(), text);
        // the size is part of the contract
        assert!(inflate(&packed, text.len() - 1).is_err());
        assert!(inflate(&packed, text.len() + 1).is_err());
    }

    #[test]
    fn damage_is_an_error_not_a_crash() {
        let packed = hex(DYNAMIC);
        assert!(inflate(&[], 0).is_err());
        assert!(inflate(&packed[..packed.len() / 2], 12000).is_err());
        assert!(inflate(&[0x07], 10).is_err()); // block type 3
        assert!(inflate(&hex("010b00f4fe6b756d6f207363656e6500"), 11).is_err()); // stored length check
        assert!(unpack(&[1, 0]).is_err());
        // every single-byte change either fails or still gives the promised size
        for i in 0..packed.len() {
            let mut bad = packed.clone();
            bad[i] ^= 0x55;
            if let Ok(out) = inflate(&bad, 12000) {
                assert_eq!(out.len(), 12000);
            }
        }
    }

    const DYNAMIC: &str = "edcf3b0a83401400c0abbc2324e6d3789a055753485644c4e30b1ee0f5c2d453cdde8e3ac723da18dbafc652a6369498ca3ad47f1ffba5cf54bb545fa9be53fda4fa4dd5c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8c8e85ea313";
}
