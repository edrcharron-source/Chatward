#!/usr/bin/env python3
"""Rebuilds src/renderer/src/components/vault/sort/prompts.json: the text side of the Vault photo sorter.

The sorter compares a picture's MobileCLIP S0 image embedding with these prompts' text embeddings. The text side never
changes at run time, so its embeddings are worked out here once and ship with the app; devices only need the image model.

  pip install onnxruntime tokenizers numpy
  python3 scripts/vault-sort-prompts.py <folder with tokenizer.json and text_model_quantized.onnx from Xenova/mobileclip_s0>
"""
import json, sys
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

PROMPTS = {"photo": ["a photo of a person", "a candid photo of friends", "a photo of an animal", "a photo of a landscape", "a photo of food", "a photo of a place", "a photo of an object"],
 "meme": ["a meme with caption text", "an internet meme with white text on top and bottom", "a deep fried meme", "a surreal brainrot meme", "a screenshot of a tweet with a funny picture", "a reaction image meme", "a funny picture with words on it"],
 "screenshot": ["a screenshot of a phone screen", "a screenshot of an app", "a screenshot of a website", "a screenshot of a text conversation", "a screenshot of a video game", "a screenshot of a computer desktop"]}

def main(model_dir: str) -> None:
    d = Path(model_dir)
    tok = Tokenizer.from_file(str(d / 'tokenizer.json'))
    text = ort.InferenceSession(str(d / 'text_model_quantized.onnx'))
    pad = tok.token_to_id('!')  # the tokenizer's pad token
    out = {'model': 'mobileclip_s0', 'dim': 0, 'prompts': []}
    for group, lines in PROMPTS.items():
        for line in lines:
            ids = tok.encode(line).ids[:77]
            ids += [pad] * (77 - len(ids))
            e = text.run(None, {'input_ids': np.array([ids], dtype=np.int64)})[0][0]
            e = e / np.linalg.norm(e)
            out['dim'] = len(e)
            out['prompts'].append({'group': group, 'text': line, 'embed': [round(float(x), 5) for x in e]})
    dest = Path(__file__).resolve().parent.parent / 'src/renderer/src/components/vault/sort/prompts.json'
    dest.write_text(json.dumps(out, separators=(',', ':')))
    print(f'wrote {len(out["prompts"])} prompts to {dest}')

if __name__ == '__main__':
    main(sys.argv[1])
