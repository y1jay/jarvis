# JARVIS 내 목소리 맞춤 학습 — Whisper 에 작은 덧붙임 학습(LoRA)을 해서 사용자의 목소리·말투·마이크에 맞춘다.
#   python finetune_whisper.py --data <폴더> --out <폴더> [--base openai/whisper-large-v3-turbo] [--epochs 3]
#   <폴더>/items.jsonl : {"audio": "경로(wav/ogg)", "text": "정답 문장", "split": "train"|"eval"}
# 진행 상황은 한 줄짜리 JSON 으로 출력한다 ({"stage": ..., ...}). 결과: <out>/hf (합쳐진 모델 + 토크나이저 파일)
import argparse, json, math, os, random, shutil, sys, time

# 메모리 상한: GPU(통합 메모리) 사용을 제한해 맥 전체가 느려지지 않게 (넘으면 늘리지 않고 오류로 멈춘다)
os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.3")  # 권장 작업 메모리의 30% (이 맥 기준 약 11GB)
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.25")

import numpy as np
import soundfile as sf
import torch


def log(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def load_audio(path):
    a, sr = sf.read(path, dtype="float32", always_2d=False)
    if a.ndim > 1:
        a = a.mean(axis=1)
    if sr != 16000:
        import librosa

        a = librosa.resample(a, orig_sr=sr, target_sr=16000)
    return a.astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default="openai/whisper-large-v3-turbo")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=4, help="몇 개마다 한 번 고칠지 (한 번에는 1개씩 넣어 메모리를 아낌)")
    ap.add_argument("--encoder-layers", type=int, default=4, help="학습할 인코더 뒤쪽 층 수 (목소리·마이크 특성)")
    ap.add_argument("--rank", type=int, default=32)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    random.seed(args.seed)
    torch.manual_seed(args.seed)

    from huggingface_hub import hf_hub_download
    from peft import LoraConfig, get_peft_model
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    items = [json.loads(l) for l in open(os.path.join(args.data, "items.jsonl"), encoding="utf8") if l.strip()]
    train = [x for x in items if x.get("split", "train") == "train"]
    if not train:
        log(stage="error", message="학습할 말소리가 없습니다")
        sys.exit(2)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    log(stage="load", base=args.base, device=dev, train=len(train))

    proc = WhisperProcessor.from_pretrained(args.base, language="korean", task="transcribe")
    # 반정밀도(bfloat16)로 올려 메모리 절반
    model = WhisperForConditionalGeneration.from_pretrained(args.base, torch_dtype=torch.bfloat16)
    model.config.forced_decoder_ids = None
    model.generation_config.forced_decoder_ids = None
    # 작은 학습층(LoRA)은 인코더 뒤쪽 몇 층 + 디코더에만. 앞쪽 인코더는 고정이라 중간 결과를 저장하지 않아 메모리가 적게 든다
    n_enc = model.config.encoder_layers
    enc_from = max(0, n_enc - args.encoder_layers)
    targets = [f"model.encoder.layers.{i}.self_attn.{p}" for i in range(enc_from, n_enc) for p in ("q_proj", "v_proj")]
    targets += [n for n, _ in model.named_modules() if n.startswith("model.decoder.layers.") and n.endswith(("self_attn.q_proj", "self_attn.v_proj", "encoder_attn.q_proj", "encoder_attn.v_proj"))]
    cfg = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, target_modules=targets, bias="none")
    model = get_peft_model(model, cfg)
    model.to(dev)
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    log(stage="prepare", trainable=trainable)

    prefix = proc.tokenizer.prefix_tokens  # <|startoftranscript|><|ko|><|transcribe|><|notimestamps|>

    def batch_of(rows):
        feats = proc.feature_extractor([load_audio(r["audio"]) for r in rows], sampling_rate=16000, return_tensors="pt").input_features
        ids = [prefix + proc.tokenizer.encode(" " + r["text"].strip(), add_special_tokens=False) + [proc.tokenizer.eos_token_id] for r in rows]
        n = max(len(x) for x in ids)
        dec_in = torch.full((len(ids), n - 1), proc.tokenizer.pad_token_id, dtype=torch.long)
        labels = torch.full((len(ids), n - 1), -100, dtype=torch.long)
        for i, x in enumerate(ids):
            dec_in[i, : len(x) - 1] = torch.tensor(x[:-1])
            # 앞의 지시 토큰(언어·작업)은 맞힐 대상이 아니다
            lab = x[1:]
            labels[i, : len(lab)] = torch.tensor(lab)
            labels[i, : len(prefix) - 1] = -100
        return feats.to(dev, dtype=torch.bfloat16), dec_in.to(dev), labels.to(dev)

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=0.01)
    steps_per_epoch = math.ceil(len(train) / args.batch)
    total = steps_per_epoch * args.epochs

    def mem_gb():
        try:
            return round(torch.mps.driver_allocated_memory() / 1024**3, 2) if dev == "mps" else 0
        except Exception:  # noqa: BLE001
            return 0
    warm = max(1, total // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * max(0.0, 1 - s / max(1, total)))
    model.train()
    step = 0
    t0 = time.time()
    for ep in range(args.epochs):
        random.shuffle(train)
        for b in range(0, len(train), args.batch):
            group = train[b : b + args.batch]
            loss_sum = 0.0
            # 한 번에 1개씩 넣고 기울기만 모은다 (메모리 절약)
            for row in group:
                feats, dec_in, labels = batch_of([row])
                out = model(input_features=feats, decoder_input_ids=dec_in, labels=labels)
                (out.loss.float() / len(group)).backward()
                loss_sum += float(out.loss.detach().float().cpu())
                del out, feats, dec_in, labels
            torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            if dev == "mps":
                torch.mps.empty_cache()
            step += 1
            log(stage="train", step=step, total=total, epoch=ep + 1, loss=round(loss_sum / len(group), 4), elapsed=round(time.time() - t0, 1), mem_gb=mem_gb())

    log(stage="merge")
    merged = model.merge_and_unload()
    hf = os.path.join(args.out, "hf")
    os.makedirs(hf, exist_ok=True)
    # whisper.cpp 변환기는 float 가중치를 읽는다
    merged.to("cpu").to(torch.float16).save_pretrained(hf, safe_serialization=True)
    proc.save_pretrained(hf)
    # whisper.cpp 변환기가 쓰는 원래 어휘 파일
    for f in ["vocab.json", "added_tokens.json", "merges.txt", "normalizer.json"]:
        try:
            shutil.copy(hf_hub_download(args.base, f), os.path.join(hf, f))
        except Exception:  # noqa: BLE001
            pass
    log(stage="done", out=hf, seconds=round(time.time() - t0, 1))


if __name__ == "__main__":
    main()
