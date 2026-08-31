# Third-Party Notices

Sticky Note Lab includes third-party software, OCR models, language data and dictionaries. Those components remain subject to their own licenses. This document records the versions and bundled assets used by the current repository; it does not replace the referenced license texts and does not grant rights to the Sticky Note Lab application code itself.

## Browser-distributed OCR components

| Component | Version or bundled asset | License | Upstream | Included license / notice |
| --- | --- | --- | --- | --- |
| `@paddleocr/paddleocr-js` | 0.4.2 | Apache-2.0 | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) | Apache-2.0 text is included with the package in `node_modules` during development. Model provenance is recorded below. |
| PaddleOCR / PaddleX models | `PP-OCRv6_small_det_onnx_infer.tar`, `PP-OCRv6_medium_rec_onnx_infer.tar` | Apache-2.0 | [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) and official Paddle model storage | [`public/ocr-models/README.md`](public/ocr-models/README.md) |
| DE·HTR v2 | `public/ocr-models/dehtr-v2/model.onnx` | Apache-2.0 | Copyright 2026 naeyn | [`public/licenses/dehtr-v2/LICENSE.txt`](public/licenses/dehtr-v2/LICENSE.txt), [`NOTICE.txt`](public/licenses/dehtr-v2/NOTICE.txt) |
| ONNX Runtime Web | 1.24.3 and 1.27.0 browser side modules | MIT | [Microsoft ONNX Runtime](https://github.com/microsoft/onnxruntime) | [`public/onnx-paddle-1.24.3/LICENSE.txt`](public/onnx-paddle-1.24.3/LICENSE.txt), [`public/onnx-dehtr-1.27/LICENSE.txt`](public/onnx-dehtr-1.27/LICENSE.txt) |
| Tesseract.js and Tesseract Core | 7.0.0 browser worker and WASM modules | Apache-2.0; bundled worker also contains MIT-licensed components | [Tesseract.js](https://github.com/naptha/tesseract.js) | [`public/tesseract/LICENSE.md`](public/tesseract/LICENSE.md), [`public/tesseract/worker.min.js.LICENSE.txt`](public/tesseract/worker.min.js.LICENSE.txt), [`public/tesseract-core/LICENSE`](public/tesseract-core/LICENSE) |
| Tesseract language data | German and English trained-data files | Apache-2.0 | [tesseract-ocr](https://github.com/tesseract-ocr) | [`public/tessdata/LICENSE`](public/tessdata/LICENSE) |
| `dictionary-de` / igerman98 | 3.0.0; German Hunspell data | GPL-2.0-only OR GPL-3.0-only | [wooorm/dictionaries](https://github.com/wooorm/dictionaries/tree/main/dictionaries/de) | [`public/dictionaries/LICENSE-de.txt`](public/dictionaries/LICENSE-de.txt); full [GPL-2.0](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html) and [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) texts |
| `dictionary-en` / SCOWL | 4.0.0; American English Hunspell data | MIT AND BSD, with additional source notices reproduced in the license file | [wooorm/dictionaries](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en) | [`public/dictionaries/LICENSE-en.txt`](public/dictionaries/LICENSE-en.txt) |

Commercial use is not prohibited by the licenses above. Redistribution may require preserving license and copyright notices; redistribution of the German dictionary must additionally follow the selected GPL version's conditions. The dictionaries are separate data assets and are not relicensed as part of Sticky Note Lab.

## Model and language-data integrity

The following SHA-256 values identify the exact large files tracked by Git LFS:

| Asset | SHA-256 |
| --- | --- |
| `public/ocr-models/PP-OCRv6_small_det_onnx_infer.tar` | `D218F6FBF0F1C23D2161BD6AC7F5EAA6104FA89955C09290497E31008E2618E4` |
| `public/ocr-models/PP-OCRv6_medium_rec_onnx_infer.tar` | `2D0080895E4FE17E0ADEEAE5C8F0C19401BC5BBB87B9F244967C73647DE9F553` |
| `public/ocr-models/dehtr-v2/model.onnx` | `B576A0A1281B9BE46B2574028B75575E041B7D7CB650F063886E733467CC1499` |
| `public/tessdata/deu.traineddata.gz` | `306C4280D0CBED46FBFF727486BD43B92730181BAE80F56941A091F363BDF28B` |
| `public/tessdata/eng.traineddata.gz` | `45B4CB346724AC1774F1C36F42F182B887BCDB28EBE63E6FFF90AC41F3FCFF91` |

## Application runtime dependencies

Direct runtime dependencies used by the application:

| Package | Version | License |
| --- | --- | --- |
| `drizzle-orm` | 0.45.2 | Apache-2.0 |
| `lucide-react` | 1.31.0 | ISC |
| `nspell` | 2.1.5 | MIT |
| `onnxruntime-web` | 1.27.0 | MIT |
| `pptxgenjs` | 4.0.1 | MIT |
| `react`, `react-dom` | 19.2.6 | MIT |
| `tesseract.js` | 7.0.0 | Apache-2.0 |

Relevant transitive runtime packages are licensed under Apache-2.0, MIT, ISC, BSD-2-Clause, BSD-3-Clause, Boost Software License 1.0 or Python-2.0. This includes `@techstark/opencv-js`, `flatbuffers`, `idb-keyval`, `long`, `tesseract.js-core`, `wasm-feature-detect`, the `@protobufjs/*` packages, `protobufjs`, `clipper-lib`, `guid-typescript`, `bmp-js`, `node-fetch`, `regenerator-runtime`, `scheduler`, `webidl-conversions`, `whatwg-url` and `zlibjs`.

The authoritative package versions are pinned in `pnpm-lock.yaml`. A fresh inventory can be generated with:

```bash
pnpm licenses list --prod
```

## Build and development tools

The source repository also references build and test tooling, including Vinext, Vite, TypeScript, ESLint, Tailwind CSS, Wrangler and Cloudflare packages. These tools are not presented as Sticky Note Lab code and retain the licenses declared by their respective packages and lockfile entries.

## Assets created for this repository

- `public/og.png` is the project-specific social preview for Sticky Note Lab.
- The repository intentionally contains no third-party board photograph or stock-photo fixture.
- The simple SVG interface icons shipped in `public/` originate from the project starter and remain covered by their original source terms where applicable.

## No endorsement or trademark license

Names and marks of third parties are used only to identify their components. Their inclusion does not imply endorsement and does not grant a trademark license.
