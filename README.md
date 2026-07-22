# Fast Offline Key-Sentence Annotator 1.7.0

This safety release separates model download from model execution. **Update models** downloads the selected q8 ONNX models and their tokenizer/configuration assets into the Zotero profile without loading ONNX Runtime. This prevents the segmentation fault observed when WebAssembly inference was initialized inside Zotero's main process.

The existing non-transformer ranking pipeline remains operational. Transformer inference is intentionally disabled until it can be moved to a process boundary that cannot terminate Zotero.
