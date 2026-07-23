# Findings & Decisions

## Delete skim annotations
- Existing generated tags are `auto-key-sentence` plus optional `auto-${role}`; duplicate detection matches only `auto-key-sentence`.
- `makeAnnotation()` is the single tag-creation site; `annotateAttachment()` performs duplicate detection through `attachment.getAnnotations()`.
- Menu lifecycle currently stores one menu item in `windowState`; test fake XUL elements expose attributes as properties and dispatch handlers synchronously.
- Deletion will target annotations with at least one tag whose name starts with `autoskim-`, using each annotation's Zotero item deletion method.
