# JARVIS Qwen3-TTS 목소리 서버 (맥 전용, MLX). JARVIS 가 직접 띄우고 끈다.
#   POST /speak  {"text": "...", "voice": {"kind": "custom", "speaker": "sohee"} | {"kind": "clone", "ref_audio": "...wav", "ref_text": "..."}, "speed": 1.0}
#     → audio/wav (24kHz mono 16bit)
#   GET  /health → {"ok": true, "loaded": [...]}
#   POST /warm   {"voice": {...}}  모델을 미리 올려 둔다
import io, json, sys, threading, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import mlx.core as mx
from mlx_audio.tts.utils import load_model

MODELS = {
    "custom": "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit",
    "clone": "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-6bit",
}
loaded = {}
lock = threading.Lock()


def model(kind):
    if kind not in loaded:
        loaded[kind] = load_model(MODELS[kind])
    return loaded[kind]


def synth(text, voice, speed=1.0):
    kind = voice.get("kind", "custom")
    with lock:
        mx.random.seed(7)  # 같은 목소리가 문장마다 흔들리지 않게
        m = model(kind)
        if kind == "custom":
            gen = m.generate_custom_voice(text=text, speaker=voice.get("speaker", "sohee"), language="Korean", instruct=voice.get("instruct"))
        else:
            gen = m.generate(text=text, ref_audio=voice["ref_audio"], ref_text=voice["ref_text"], lang_code="korean")
        chunks = [np.array(r.audio) for r in gen]
    audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    if speed and abs(speed - 1.0) > 0.01:
        idx = np.arange(0, len(audio), speed)
        audio = np.interp(idx, np.arange(len(audio)), audio).astype(np.float32)
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "loaded": list(loaded)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/warm":
                synth("네.", body.get("voice", {}))
                return self._json(200, {"ok": True, "loaded": list(loaded)})
            if self.path == "/speak":
                wav = synth(body["text"], body.get("voice", {}), float(body.get("speed", 1.0)))
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
                return
            self._json(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": str(e)})


if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 0
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(json.dumps({"ready": True, "port": srv.server_address[1]}), flush=True)
    srv.serve_forever()
