# MediaPipe models

The live cut-out mask and the face finder run these three models from Google's MediaPipe, through
`@mediapipe/tasks-vision` (`src/renderer/src/vision/`). They are the files Google publishes, unchanged:

| File | Model | Source | SHA-256 |
|---|---|---|---|
| `blaze_face_short_range.tflite` | BlazeFace (short range), face detection | [face_detector/blaze_face_short_range/float16/1](https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite) | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| `selfie_segmenter.tflite` | Selfie segmentation, person mask | [image_segmenter/selfie_segmenter/float16/1](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite) | `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b` |
| `selfie_multiclass_256x256.tflite` | Selfie multiclass segmentation (hair, skin, clothes...), person mask | [image_segmenter/selfie_multiclass_256x256/float32/1](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite) | `c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0` |

The models are by Google and are under the Apache License 2.0: see `LICENSE` in this folder and the
[MediaPipe model list](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter#models). They are not
covered by CUTOUT's MIT licence.
