import os
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]/'data'
MODEL=ROOT/'models'/'road-cityscapes.onnx'
WEIGHTS='https://huggingface.co/Xenova/segformer-b0-finetuned-cityscapes-1024-1024/resolve/main/onnx/model.onnx'
MEAN=np.array([.485,.456,.406],dtype=np.float32)
STD=np.array([.229,.224,.225],dtype=np.float32)


@lru_cache(maxsize=1)
def model():
    import onnxruntime
    if not MODEL.exists():
        import requests
        MODEL.parent.mkdir(exist_ok=True,parents=True)
        response=requests.get(WEIGHTS,timeout=90)
        response.raise_for_status()
        download=MODEL.with_suffix(f'.{os.getpid()}.part')
        download.write_bytes(response.content)
        download.replace(MODEL)
    options=onnxruntime.SessionOptions()
    options.intra_op_num_threads=2
    options.inter_op_num_threads=1
    return onnxruntime.InferenceSession(str(MODEL),options,providers=['CPUExecutionProvider'])


def labels(frame_id,image):
    folder=ROOT/'streetview'/'semantics'
    folder.mkdir(exist_ok=True,parents=True)
    path=folder/f'{frame_id}.png'
    if path.exists():
        with Image.open(path) as cached:
            return np.array(cached)
    w,h=image.size
    size=(max(64,round(w*416/max(w,h)/32)*32),max(64,round(h*416/max(w,h)/32)*32))
    image=image.convert('RGB').resize(size,Image.Resampling.BILINEAR)
    pixels=((np.asarray(image,dtype=np.float32)/255-MEAN)/STD).transpose(2,0,1)[None]
    scores=model().run(None,{'pixel_values':pixels})[0][0]
    best=scores.argmax(axis=0).astype(np.uint8)
    delta=scores-scores.max(axis=0)
    probability=1/np.exp(delta).sum(axis=0)
    best[probability<.72]=255
    best=np.asarray(Image.fromarray(best).resize(size,Image.Resampling.NEAREST))
    tmp=path.with_suffix(f'.{os.getpid()}.{threading.get_ident()}.tmp')
    Image.fromarray(best).save(tmp,format='PNG')
    tmp.replace(path)
    return best
