# Zotero Skimming

Automatic annotations of PDF inside Zotero for skimming academic literature.

## Current version

Version 1.7.0 provides full-PDF parsing, Zotero-native highlights, configurable annotation density, filtering of references and tables, and optional locally cached quantized transformer stages for embeddings, classification, and reranking.

## Installation

Build or install the XPI in Zotero 9, then right-click a PDF attachment and choose **Annotate key sentences…**. The settings dialog controls annotation density and the optional transformer stages.

## Model handling

**Update models** downloads the selected quantized model assets into the Zotero profile and reports progress. Model-free TF-IDF/TextRank scoring remains available as the baseline mode.

## Repository

https://codeberg.org/00sapo/zotero-skimming
