# Code Parcel: Select Files, One Snapshot

**Give AI the project context it needs — without copying files one by one.**

Code Parcel is a Visual Studio Code extension that combines selected project files into a single Markdown snapshot containing their folder structure and complete saved text contents.

Use the snapshot with ChatGPT, Claude, Gemini, or another AI assistant to understand your codebase, investigate problems, review architecture, or plan changes.

![Code Parcel — Select Files, One Snapshot](https://binaryhandshake.com/wp-content/uploads/2026/11/code-parcel-project-snapshot.png)

## Features

- **Selective export:** choose individual files or entire folders using native checkboxes in a dedicated Explorer panel.
- **One Markdown file:** combine the selected project structure and source code into a structured document.
- **Automatic updates:** regenerate the snapshot when project files are saved, or generate it manually.
- **Persistent selections:** keep your file selections across VS Code restarts.
- **Custom output:** change the snapshot filename prefix and destination folder.
- **Smart exclusions:** exclude common dependencies, generated files, and sensitive files by default.
- **Multi-root support:** maintain independent selections and settings for each workspace folder.
- **Local processing:** no accounts, uploads, or external AI connections.

## Installation

Code Parcel is free to install from the Visual Studio Code Marketplace.

1. Open VS Code.
2. Open **Extensions** (`Ctrl+Shift+X`).
3. Search for **Code Parcel** by **Binary Handshake Studio**.
4. Click **Install**.

For more information, visit the
[official Code Parcel project page](https://binaryhandshake.com/code-parcel/).

## Getting Started

1. Open your project in VS Code and press **Ctrl+Shift+E** to open Explorer.
2. Find the **Code Parcel** panel and expand your project folder.
3. Check the files and folders you want to include.
4. Click **Generate Snapshot** in the panel toolbar.
5. Open the generated Markdown file and copy its contents or attach it to your AI conversation.

The checkboxes are in the separate Code Parcel panel, not the standard Explorer file tree.

## File Selection

Code Parcel displays the workspace's regular file and folder structure, including hidden folders such as `.git`, `.vscode`, and custom tool directories. Most project text files are included by default. Typical hidden directories, dependencies, build and cache artifacts, logs, sensitive files, and previous `*-output.md` snapshots start unchecked, but remain visible and selectable.

Default exclusions are preferences. Check a file or folder to include it; you can also select one file inside an otherwise excluded folder without including its other contents. Code Parcel remembers these selections for each workspace folder.

Known binary files and the currently configured generated snapshot cannot be included. Files larger than the configured size limit may be skipped during generation. Code Parcel's mandatory safeguards apply to the active snapshot and its internal temporary and lock files, not to user-owned project directories.

You can also run **Code Parcel: Generate Snapshot** from the Command Palette (**Ctrl+Shift+P**).

Automatic generation is enabled by default. The snapshot updates after standard VS Code save events, including saves triggered by **Ctrl+S** or Auto Save. Generation requires a trusted workspace.

## Output Settings

By default, the snapshot is saved in your project root as:

`<project-name>-output.md`

For example: `my-website-output.md`.

To change the output:

1. Click the **gear icon** in the Code Parcel panel header.
2. Choose **Change filename prefix** or **Choose a custom folder**.
3. Select **Save settings** to apply your changes.

To restore the default location, choose **Use the project root** and save.

Snapshot filenames always end in `-output.md`.

## Advanced Configuration

Run **Code Parcel: Open Settings** from the Command Palette to edit the project configuration:

`.vscode/code-parcel.json`

Available settings include:

- `autoGenerateOnSave` — enable or disable automatic generation.
- `excludedPaths` — configure file and folder exclusions.
- `maxFileSizeBytes` — set the maximum size of an included file.
- `outputFile` — set the snapshot filename.
- `outputDirectory` — set the destination folder (`null` uses the project root).
- `selectionOverrides` — store explicit file and folder selections.

## Privacy

Code Parcel processes files locally and does not upload code or collect telemetry.

Sensitive files are excluded by default, and binary or oversized files are not embedded in the snapshot.

**Always review the generated Markdown before sharing it with an external AI service.**

Snapshots can help developers and AI assistants understand a project. They do not reproduce Git history or the runtime environment and are not a complete project backup or restoration tool.
