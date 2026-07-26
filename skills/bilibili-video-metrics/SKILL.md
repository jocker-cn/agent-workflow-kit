---
name: bilibili-video-metrics
description: Run the Bilibili public-video metrics demo: use user-entered SMS verification, select a requested hot-search rank, and report the first actual video result's visible metrics.
---

# Bilibili video metrics workflow

Use this Skill only when the user explicitly asks for this Bilibili demo workflow.

## Business rules

- Use the `bilibili-video-metrics` workflow contract and the common project runtime. Do not repeat browser-operation instructions here.
- Use SMS login. Read the phone number from `BILIBILI_PHONE`; the user enters the SMS code. Preserve the same run through this human checkpoint and continue after visible login succeeds.
- Use the hot-search rank requested by the user; default to rank 1. Read that item's text exactly as displayed, record it as `search.hotSearchTerm`, and add `hot-search` evidence for the source page.
- Move to `OPEN_VIDEO`. From the resulting page, select the first actual video result—not an ad, live stream, user profile, topic, or filter.
- Move to `COLLECT_METRICS`. Record the visible URL plus likes, coins, favorites, shares, and comments. Preserve displayed formatting; record `N/A` if a requested metric is not visible. Add `video` evidence.
- Move to `REVIEW`, present the collected metrics in a concise terminal and chat result, move to `DONE`, then close the session.

- Do not like, coin, favorite, share, comment, follow, publish, or otherwise modify Bilibili content. This workflow is read-only after login.
