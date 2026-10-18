// 브라우저 안에서 한국어 글자를 읽습니다 (Tesseract.js, 프로젝트에 포함된 파일만 사용).
// 이미지는 서버로 보내지 않고 저장하지도 않습니다.

let workerPromise = null;
let queue = Promise.resolve();
let onProgress = () => {};

function abs(path) {
  return new URL(path, document.baseURI).href;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('OCR 엔진 파일을 불러오지 못했어요 (vendor/tesseract 폴더를 확인하세요)'));
    document.head.append(s);
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(abs('vendor/tesseract/tesseract.min.js'));
      const worker = await window.Tesseract.createWorker('kor', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core/'),
        langPath: abs('vendor/tesseract/lang/'),
        gzip: true,
        workerBlobURL: false,
        logger: (m) => onProgress(m),
      });
      // PSM 6(하나의 균일한 글자 덩어리)가 콜카드처럼 줄 단위로 읽어야 하는 화면에 가장 잘 맞았습니다.
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      return worker;
    })().catch((e) => {
      workerPromise = null; // 다음 시도에서 다시 불러오게 함
      throw e;
    });
  }
  return workerPromise;
}

// ---------- 이미지 전처리 ----------
// 콜카드는 검은 배경의 어두운 화면이 많고, 글자가 작거나 대비가 낮은 경우가 많아서
// 읽기 전에 (1) 맨 위 상태바를 잘라내고 (2) 흑백으로 바꾸고 (3) 어두운 화면이면 반전하고 (4) 적당히 키웁니다.
export const DEFAULT_PREP = { crop: 0.023, scale: 1.5, invert: 'auto', stretch: true, binarize: true, maxSide: 6000 };

async function loadBitmap(file) {
  if (globalThis.createImageBitmap) return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

export async function preprocess(file, options = {}) {
  const o = { ...DEFAULT_PREP, ...options };
  const bmp = await loadBitmap(file);
  const sw = bmp.width;
  const sh = bmp.height;
  const top = Math.round(sh * o.crop);
  const ch = sh - top;
  let scale = o.scale;
  if (Math.max(sw, ch) * scale > o.maxSide) scale = o.maxSide / Math.max(sw, ch);
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(ch * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, top, sw, ch, 0, 0, w, h);
  bmp.close?.();

  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const g = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
    gray[i] = g;
    hist[gray[i]]++;
    sum += g;
  }
  const dark = sum / n < 128;
  const invert = o.invert === 'auto' ? dark : Boolean(o.invert);

  // 대비 늘리기: 아래·위 1% 를 잘라 0~255 로 펴기
  let lo = 0;
  let hi = 255;
  if (o.stretch) {
    let acc = 0;
    while (lo < 254 && (acc += hist[lo]) < n * 0.01) lo++;
    acc = 0;
    while (hi > lo + 1 && (acc += hist[hi]) < n * 0.01) hi--;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < n; i++) {
    let v = o.stretch ? ((gray[i] - lo) * 255) / range : gray[i];
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    gray[i] = invert ? 255 - v : v;
  }

  if (o.binarize) {
    // Otsu 방법으로 글자/배경을 갈라 또렷하게
    const h2 = new Uint32Array(256);
    for (let i = 0; i < n; i++) h2[gray[i]]++;
    let total = 0;
    for (let t = 0; t < 256; t++) total += t * h2[t];
    let wB = 0;
    let sumB = 0;
    let best = 0;
    let thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += h2[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * h2[t];
      const between = wB * wF * (sumB / wB - (total - sumB) / wF) ** 2;
      if (between > best) {
        best = between;
        thr = t;
      }
    }
    for (let i = 0; i < n; i++) gray[i] = gray[i] > thr ? 255 : 0;
  }

  for (let i = 0, j = 0; i < n; i++, j += 4) {
    px[j] = px[j + 1] = px[j + 2] = gray[i];
    px[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function setProgressListener(fn) {
  onProgress = fn ?? (() => {});
}

/**
 * 이미지(File/Blob)를 읽어 텍스트를 돌려줍니다. 여러 장은 한 장씩 차례로 처리합니다.
 * onStart: 이 이미지의 차례가 와서 실제로 읽기 시작할 때 호출됩니다.
 */
export function recognize(file, onStart, options = {}) {
  const run = async () => {
    onStart?.();
    const worker = await getWorker();
    let input = file;
    if (options.prep !== false) {
      try {
        input = await preprocess(file, options.prep && typeof options.prep === 'object' ? options.prep : {});
      } catch {
        input = file; // 전처리에 실패하면 원본 그대로 읽습니다.
      }
    }
    const { data } = await worker.recognize(input);
    return data.text;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/**
 * 파일 내용의 해시 (같은 스크린샷을 두 번 저장하지 않기 위함).
 * https 또는 localhost 에서는 SHA-256, 폰에서 http://192.168... 주소로 열면 crypto.subtle 이 없어서 FNV-1a 로 대신합니다.
 */
export async function hashFile(file) {
  const buf = await file.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return 's' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const bytes = new Uint8Array(buf);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[bytes.length - 1 - i], 0x85ebca6b) >>> 0;
  }
  return 'f' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + bytes.length.toString(16);
}
