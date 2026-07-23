# Issues

1. summarization causes wasm segmentation fault
2. if an LLM step is selected and it fails, then the error should be reported and the process should
   stop
3. the gpu is not being used
4. LLM for classification is slow, perhaps we need a smaller model
5. perhaps we should re-rank everything (i.e. 1.0 weight to re-ranking) when we manage to get
   a functional and detailed summary
6. the length of the summary should vary with the number of requested sentences
7. scoring should be different if tf-idf is used
