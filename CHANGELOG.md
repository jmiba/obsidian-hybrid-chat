# Changelog

## 0.1.10 — 2026-11-04

### Added

- Request and retain OHS preview anchors so current-vault citations select or scroll near their matching passage, with stale-position and heading fallbacks. Include heading jumps in cross-vault citation and copied chat links when available.
- Add a per-vault connection check in settings with MCP tool discovery and read-only OHS index diagnostics.
- Add a local multi-query trial runner with fixed retrieval budgets, alternating variant order, native rank fusion, timings, and pooled candidates for relevance review.

### Clarified

- Explain in settings and the privacy documentation that OHS content exclusions do not redact note excerpts sent to the chat provider or saved in chat history.

## 0.1.9 — 2026-10-11

### Fixed

- Stop showing "This answer did not cite a retrieved source." while the answer is still streaming. A neutral source list is shown until generation finishes, then the final cited and uncited presentation appears.

## 0.1.8 — 2026-09-29

### Improved

- Separate notes cited in an answer from context notes retrieved but not cited. Number cited notes in first-mention order and keep the remaining notes in a collapsed list.
- Use the same citation numbers and source grouping when copying a chat as Markdown.

### Fixed

- Recognize square and decorative citation markers, including spacing and invisible characters inside the brackets. Show unknown source markers as unverified.
- Restore normal line wrapping when a provider inserts narrow no-break spaces between words. The saved provider response is preserved.

## Previous releases

Earlier release history is available in [GitHub Releases](https://github.com/jmiba/obsidian-hybrid-chat/releases).
