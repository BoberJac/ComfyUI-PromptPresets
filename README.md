# ComfyUI Prompt Presets

A small ComfyUI node that keeps positive/negative prompt pairs as named presets and outputs them as
two `CONDITIONING` streams. It is aimed at workflows where you juggle many prompts: everything is
saved in a plain JSON file, edits auto-save, and the node shows how many tokens each field really
costs for Anima's text encoder.

## Features

- **Named presets** for positive + negative prompts, stored in `prompt_presets.json` next to the node.
- **Auto-save** (toggleable): edits are written back to the selected preset after a short pause, and
  forced again right before a prompt is queued.
- **Buttons inside the node**: `Auto-save`, `New Preset`, `Load Preset`, `Save Preset`, `Delete Preset`.
- **Token counter**: live `pos`/`neg` counts using the same Qwen-3 tokenizer Anima uses (see the note
  below). Counts above 200 turn amber.
- **Camera input**: any `STRING` connected to `camera_input` is prepended to the positive prompt,
  separated by a blank line.
- **Two outputs**: `positive` and `negative` as `CONDITIONING`, encoded like `CLIPTextEncode`.

## Installation

**ComfyUI Manager:** search for `Prompt Presets`, install, restart ComfyUI.

**Manual:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/BoberJac/ComfyUI-PromptPresets
```

Restart ComfyUI. The node appears as **Prompt Presets** under `conditioning`, or search for
"Prompt Presets" in the node search.

No extra Python dependencies.

## Node

| Socket | Type | Description |
| --- | --- | --- |
| `clip` | `CLIP` | Text encoder used for both prompts. |
| `preset` | combo | Saved preset to use. The list is read from the JSON file on load and refreshed after save/delete. |
| `positive` | `STRING` | Positive prompt text. |
| `negative` | `STRING` | Negative prompt text. |
| `preset_name` | `STRING` | Name used by **Save Preset**. |
| `camera_input` | `STRING` (optional) | Prepended to the positive prompt when connected and non-empty. |

| Output | Type |
| --- | --- |
| `positive` | `CONDITIONING` |
| `negative` | `CONDITIONING` |

## How presets work

The JSON file is the source of truth. During execution the node always reads the selected preset from
`prompt_presets.json`; the widget values stored in the workflow are only a fallback for a preset that
was deleted after the workflow was saved. That means:

- **Auto-save on** (default): change a field, wait a second, and the preset is updated. Changes are
  also flushed right before you queue a prompt.
- **Auto-save off**: nothing is written until you press **Save Preset**.
- **New Preset** clears the prompt fields and pauses auto-save, so you can type a fresh preset and
  save it under a new name without overwriting the old one.
- **Delete Preset** asks for confirmation and removes only the JSON entry.

Format:

```json
{
  "Portrait, daylight": {
    "positive": "best quality, soft light, 85mm photo",
    "negative": "worst quality, blurry, extra fingers"
  }
}
```

Presets are saved with `indent=2` and UTF-8, so the file stays readable and diff-friendly. Writes are
atomic (temporary file + rename), so a crash cannot leave a half-written JSON behind.

To start with an example file, copy `prompt_presets.example.json` to `prompt_presets.json`.

## Token counter

The counter calls the Qwen-3 0.6B tokenizer from `comfy.text_encoders.anima`, i.e. the exact tokenizer
Anima uses, because "how many tokens" only makes sense for a specific text encoder. Requirements:

- ComfyUI with Anima text encoder support (`comfy.text_encoders.anima.Qwen3Tokenizer`).
- The tokenizer's embedding files available through ComfyUI's `embeddings` folder paths.

On any other model the counter shows `pos —` / `neg —` and the node keeps working normally. The
`camera_input` text is not counted, because it is prepended at execution time.

## Notes

- The node ignores prompt widget values when the selected preset exists in JSON. This is intentional:
  it prevents an old workflow copy from silently overriding a freshly auto-saved preset.
- `preset` validation is relaxed on purpose, so a workflow that references a deleted preset still
  loads and queues.
- Works with any `CLIP` (Anima, SDXL, SD1.5, Flux, ...); only the token counter is Anima-specific.

## License

MIT, see [LICENSE](LICENSE).
