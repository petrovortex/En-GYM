# Third-party components

The application code and original practice items use the project MIT license. The Windows installer includes Node.js and the application libraries. Setup downloads the speech components. Their licenses and source distributions are listed below.

| Component | Source |
| --- | --- |
| Node.js 24.22.2 | [Node.js release, source and licenses](https://nodejs.org/dist/v24.22.2/) |
| React, React DOM, Scheduler | [React](https://github.com/facebook/react) |
| JOSE | [JOSE](https://github.com/panva/jose) |
| phonon-tts 0.7.0 (official WASM runtime, used in a Node worker) | [Runtime source and licenses](https://github.com/gradium-ai/xn-ptts/tree/v0.7.0/ptts-wasm) · [Package](https://www.npmjs.com/package/phonon-tts/v/0.7.0) |
| Phonon 31M English, Q8 | [Pinned model and license](https://huggingface.co/gradium/phonon-31m-en/tree/92741c5b07d085ff840e26fea8ce43110b87852f) |
| Phonon English voice embeddings (default, Hadley, Preston) | [Published voice catalog](https://huggingface.co/gradium/phonon-voices/tree/0ee17205f254b5abc43b266c8a0f215565c352f7) |
| whisper.cpp 1.7.6 | [Tagged source](https://github.com/ggml-org/whisper.cpp/tree/v1.7.6) |
| Whisper English base model, Q5_1 | [Model distribution](https://huggingface.co/ggerganov/whisper.cpp) and [original model](https://github.com/openai/whisper) |
| SDL2 | [SDL](https://github.com/libsdl-org/SDL) |
| Visual C++ Redistributable | [Microsoft distribution and license](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/) |

The ETS format specification guides the practice blueprint. The questions, mock routes, scoring estimates, and interface are independently implemented.

