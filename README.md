# Smart Reading List

A fork of [Zotero Reading List](https://github.com/Dominic-DallOsto/zotero-reading-list) with smart auto-completion features for PDFs and HTML articles.

An extension for Zotero that allows setting the read status of items.

- default read statuses are: `⭐ New`, `📙 To Read`, `📖 In Progress`, `📗 Read`, or `📕 Not Reading`
- custom read statuses are also supported
- newly added items can be automatically labelled
- an item's read status can be automatically updated when opening its attached PDF or HTML snapshot
- **items are automatically marked complete when you finish reading them** (PDF page threshold or HTML scroll position + dwell time)
- new items automatically advance to the next status after a configurable number of days

![windows dark theme overview](https://github.com/Dominic-DallOsto/zotero-reading-list/assets/26859884/e35ef424-02cd-4bec-8866-3e1d30c9aadf)

Change an item's status by right clicking or by using the shortcut keys Alt+1 to Alt+5 (supports multiple items at once).

![right click menu](https://github.com/Dominic-DallOsto/zotero-reading-list/assets/26859884/10c46660-445d-4591-ad99-777fe58f788f)

You can also remove an item's read status through the right click menu or with the shortcut Alt+0.

## Installation

Download the latest `smart-reading-list.xpi` from [Releases](../../releases/latest) and install via Tools → Plugins → gear icon → Install Plugin From File.

After installing:
1. Restart Zotero
2. Right click on the item pane column header and enable the Read Status column
3. Go to Settings → Reading List and click **Apply to untracked items** to initialize your existing library

## Options

Under Edit → Settings → Reading List you can configure the following options:

| Option | Description |
| --- | --- |
| Enable Keyboard Shortcuts | With an item selected, press Alt+1, Alt+2, … to set that item's read status. Note: this disables Zotero's built-in shortcut for changing the sort column (also Alt+NUM). |
| Read Status Column Format | Whether to show icons along with the status, just the text, or just the icons. |
| Use Icon as Item Tree Header | Show the extension icon instead of "Read Status" as the column header. |
| Custom Read Statuses and Icons | Choose custom read status names and icons. Keyboard shortcuts work up to Alt+9. If you delete a status it remains on existing items — change or clear them manually. |
| Automatically Change Status When Opening Attachment | Custom mapping for how statuses update when you open an attached PDF or snapshot (e.g. New → In Progress). |
| Automatically Label New Items | Automatically apply a read status to items when you add them to Zotero. |
| New Item Expiry | Automatically advance items in the "New" status to the next status after a configurable number of days (0 to disable). |
| Initialize Existing Library | One-click button to apply the default status to all items in your library that the plugin hasn't seen yet. Useful after first install. |
| Auto-complete on Finish | Automatically mark items as finished when you reach the end of a PDF or HTML article. |
| Completion Status | Which status to set when an item is marked complete. |
| Completion Threshold | How far through a PDF (% of pages) before it's considered complete. |
| HTML Dwell Time | How many seconds you must stay near the end of an HTML article before it's marked complete (default 15s). If you scroll back up the timer resets. |

## How Auto-Completion Works

### PDFs
The plugin tracks which pages you visit. When you close a PDF, if the furthest page you reached (or the last page you had open) is within the completion threshold of the end, the item is automatically marked with your chosen completion status.

### HTML Snapshots
The plugin tracks your scroll position. Once you scroll to within the completion threshold of the bottom, a timer starts. If you stay there for the configured dwell time (default 15 seconds) without scrolling back up, the item is marked complete. Closing the article while past the threshold also triggers completion.

## Differences from Upstream

This fork adds:
- **Smart Reading Completion** — auto-marks PDFs and HTML articles as read when you finish them
- **HTML scroll tracking** — works with saved web page snapshots, not just PDFs
- **New Item Expiry** — automatically advances stale "New" items
- **Initialize Existing Library** — one-click setup for pre-existing libraries
