"""CUTOUT HQ matte (optional): turns a video (or image) into a grayscale mask video (or PNG) on the GPU.

Engines:
  saliency  transparent-background (InSPyReNet; it downloads its checkpoint to ~/.transparent-background on first
            use). The main subject, whatever it is: people, chairs, products. Best edges.
  people    YOLO person masks gate the InSPyReNet matte: people only, still with fine edges.
            Weights: the CUTOUT_YOLO_WEIGHTS environment variable (a YOLO segmentation .pt file, or a folder that
            holds one, for example ComfyUI's models/ultralytics/segm). Not set: Ultralytics' yolo11m-seg.pt, which
            Ultralytics downloads once into the --models folder.

Protocol (read by the Electron main process): "STATUS <text>" and "PROGRESS <done>/<total>" lines on stdout.
Exit code 4 means "not set up" (a Python package or the YOLO weights are missing); the reason is the last stderr line,
starting with "NOT SET UP: ".
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

NOT_SET_UP = 4


def not_set_up(reason: str) -> None:
    print(f"NOT SET UP: {reason}", file=sys.stderr, flush=True)
    sys.exit(NOT_SET_UP)


def need(module: str, package: str):
    """Import a module, or stop with a clear "not set up" message naming the pip package."""
    import importlib

    try:
        return importlib.import_module(module)
    except ImportError as e:
        missing = f" ({e.name} is missing)" if e.name and e.name.split(".")[0] != module.split(".")[0] else ""
        not_set_up(f"the Python package {package} is not installed{missing}. See requirements.txt")


cv2 = need("cv2", "opencv-python")
np = need("numpy", "numpy")

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif"}
MAX_SIDE = 1024  # mask resolution (long side); the app contours at <=512 anyway
# Picked first when CUTOUT_YOLO_WEIGHTS is a folder (ComfyUI's models/ultralytics/segm holds the first one).
PREFERRED_WEIGHTS = ("person_yolov8m-seg.pt", "yolo11m-seg.pt", "yolo11s-seg.pt")


def status(text: str) -> None:
    print(f"STATUS {text}", flush=True)


def progress(done: int, total: int) -> None:
    print(f"PROGRESS {done}/{total}", flush=True)


def yolo_weights(models_dir: str) -> str:
    """CUTOUT_YOLO_WEIGHTS (a .pt file or a folder holding one), else yolo11m-seg.pt in models_dir (downloaded once)."""
    env = os.environ.get("CUTOUT_YOLO_WEIGHTS", "").strip().strip('"')
    if env:
        p = Path(env).expanduser()
        if p.is_file():
            return str(p)
        if p.is_dir():
            found = [p / n for n in PREFERRED_WEIGHTS if (p / n).is_file()] or sorted(p.glob("*-seg.pt"))
            if found:
                return str(found[0])
        not_set_up(f"CUTOUT_YOLO_WEIGHTS is set to {p}, but there is no YOLO segmentation .pt file there")
    if models_dir:
        Path(models_dir).mkdir(parents=True, exist_ok=True)
        return str(Path(models_dir) / "yolo11m-seg.pt")
    return "yolo11m-seg.pt"


def make_engine(name: str, models_dir: str = ""):
    # Everything that can be missing is checked before the slow model loads, so "not set up" answers at once.
    Remover = need("transparent_background", "transparent-background").Remover
    if name == "people":
        YOLO = need("ultralytics", "ultralytics").YOLO
        weights = yolo_weights(models_dir)

    status("loading InSPyReNet (transparent-background)...")
    remover = Remover(mode="base")

    def saliency(rgb: np.ndarray) -> np.ndarray:
        return remover.process(rgb, type="map")[:, :, 0]

    if name != "people":
        return saliency

    status("loading YOLO person segmentation...")
    model = YOLO(weights)

    def people(rgb: np.ndarray) -> np.ndarray:
        """YOLO says where the people are; InSPyReNet supplies the hair-level edge inside that region."""
        h, w = rgb.shape[:2]
        res = model(rgb[:, :, ::-1], classes=[0], retina_masks=True, verbose=False, conf=0.3)[0]
        if res.masks is None:
            return np.zeros((h, w), np.uint8)
        m = res.masks.data.cpu().numpy()  # n, h, w in 0..1
        if m.shape[1:] != (h, w):
            m = np.stack([cv2.resize(x, (w, h), interpolation=cv2.INTER_LINEAR) for x in m])
        person = np.clip(m.max(axis=0), 0, 1).astype(np.float32)
        # Narrow band around the YOLO mask: wide enough for hair, too thin for the furniture behind.
        s = max(h, w)
        k = max(3, int(s * 0.007)) | 1
        gate = cv2.GaussianBlur(cv2.dilate(person, np.ones((k, k), np.uint8)), (k * 2 + 1, k * 2 + 1), 0)
        kc = max(3, int(s * 0.02)) | 1
        core = cv2.erode(person, np.ones((kc, kc), np.uint8))
        sal = saliency(rgb).astype(np.float32) / 255
        out = np.maximum(sal * gate, core)
        return (np.clip(out, 0, 1) * 255).astype(np.uint8)

    return people


def fit(w: int, h: int) -> tuple[int, int]:
    k = min(1.0, MAX_SIDE / max(w, h))
    return max(2, int(round(w * k / 2)) * 2), max(2, int(round(h * k / 2)) * 2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", default="saliency", choices=["saliency", "people"])
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--models", default="", help="where Ultralytics' default YOLO weights are downloaded and kept")
    a = ap.parse_args()

    run = make_engine(a.engine, a.models)

    if Path(a.src).suffix.lower() in IMAGE_EXTS:
        Image = need("PIL.Image", "pillow")

        img = Image.open(a.src).convert("RGB")
        rgb = np.array(img)
        w, h = fit(img.width, img.height)
        rgb = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)
        progress(0, 1)
        Image.fromarray(run(rgb)).save(a.out)
        progress(1, 1)
        return 0

    cap = cv2.VideoCapture(a.src)
    if not cap.isOpened():
        print(f"cannot open {a.src}", file=sys.stderr)
        return 2
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    w, h = fit(int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    status(f"matting {total} frames at {w}x{h}...")

    enc = subprocess.Popen(
        [a.ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}", "-r", f"{fps}",
         "-i", "-", "-c:v", "libx264", "-preset", "fast", "-crf", "10", "-pix_fmt", "yuv420p", "-g", "1",
         "-movflags", "+faststart", a.out],
        stdin=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    i = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        rgb = cv2.cvtColor(cv2.resize(bgr, (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
        enc.stdin.write(np.ascontiguousarray(run(rgb)).tobytes())
        i += 1
        progress(i, max(total, i))
    cap.release()
    enc.stdin.close()
    code = enc.wait()
    if code != 0 or i == 0:
        print(f"encoder exit {code}, frames {i}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    sys.exit(main())
