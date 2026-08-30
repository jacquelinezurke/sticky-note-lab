# Local PaddleOCR models

These files are served from the same origin so the private LAN experiment does
not depend on the Paddle model CDN while scanning.

- `PP-OCRv6_small_det_onnx_infer.tar`: local PP-OCRv6 text detector
- `PP-OCRv6_medium_rec_onnx_infer.tar`: higher-quality PP-OCRv6 handwriting recognizer
- `dehtr-v2/model.onnx`: compact German line-handwriting second opinion

Source: PaddleOCR/PaddleX official inference model storage (`paddle3.0.0`).
PaddleOCR is licensed under Apache-2.0. Keep the model names and the pinned
`@paddleocr/paddleocr-js` version in sync with `app/ocr-engine.ts`.

DE·HTR v2 is Copyright 2026 naeyn and Apache-2.0 licensed. Its license and
notice are included under `public/licenses/dehtr-v2/`.
