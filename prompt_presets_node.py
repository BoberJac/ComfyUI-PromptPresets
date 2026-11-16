"""ComfyUI Prompt Presets node.

Keeps positive/negative prompt pairs as named presets in ``prompt_presets.json``
next to this file and exposes the selected pair as two CONDITIONING outputs.
An optional STRING input (for example a camera description) is prepended to the
positive prompt.

The JSON file is the source of truth: the node always reads the preset from it
on execution, so edits made in the UI without saving cannot silently win.
"""

import asyncio
import json
import logging
import os
import threading

try:
    import server
    from aiohttp import web
except ImportError:  # imported outside a running ComfyUI (lint, tests)
    server = None
    web = None

LOGGER = logging.getLogger(__name__)

PRESETS_FILE = os.path.join(os.path.dirname(os.path.realpath(__file__)), "prompt_presets.json")
NEW_PRESET_LABEL = "-- New Preset --"

_FILE_LOCK = threading.RLock()


def load_presets():
    """Read the preset file. Returns an empty dict on a missing or broken file."""
    with _FILE_LOCK:
        if not os.path.exists(PRESETS_FILE):
            return {}
        try:
            with open(PRESETS_FILE, "r", encoding="utf-8") as handle:
                presets = json.load(handle)
        except (OSError, ValueError) as exc:
            LOGGER.warning("PromptPresets: cannot read %s: %s", PRESETS_FILE, exc)
            return {}
    return presets if isinstance(presets, dict) else {}


def save_presets(presets):
    """Write the preset file atomically so a crash cannot truncate it."""
    temp_path = f"{PRESETS_FILE}.tmp"
    with _FILE_LOCK:
        try:
            with open(temp_path, "w", encoding="utf-8") as handle:
                json.dump(presets, handle, indent=2, ensure_ascii=False)
            os.replace(temp_path, PRESETS_FILE)
        except OSError as exc:
            LOGGER.warning("PromptPresets: cannot write %s: %s", PRESETS_FILE, exc)
            return False
    return True


# --- Token counter -----------------------------------------------------------
# Uses the same Qwen-3 tokenizer Anima uses for its text encoder. It is optional:
# on any other model the counter simply reports "unavailable" to the frontend.

_tokenizer = None
_tokenizer_lock = threading.Lock()


def count_tokens(text):
    text = text or ""
    if not text.strip():
        return 0

    global _tokenizer
    with _tokenizer_lock:
        if _tokenizer is None:
            import folder_paths
            from comfy.text_encoders.anima import Qwen3Tokenizer

            _tokenizer = Qwen3Tokenizer(
                embedding_directory=folder_paths.get_folder_paths("embeddings")
            )
        # tokenize_with_weights returns [[(token, weight), ...], ...]
        return sum(len(sequence) for sequence in _tokenizer.tokenize_with_weights(text) or [])


_prompt_server = getattr(getattr(server, "PromptServer", None), "instance", None)

if _prompt_server is not None:
    routes = _prompt_server.routes

    @routes.get("/prompt_presets/get_presets")
    async def get_presets(request):
        return web.json_response(load_presets())

    @server.PromptServer.instance.routes.post("/prompt_presets/save_preset")
    async def save_preset(request):
        try:
            data = await request.json()
        except ValueError:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        name = str(data.get("name", "")).strip()
        if not name or name == NEW_PRESET_LABEL:
            return web.json_response({"error": "Preset name required"}, status=400)
        if len(name) > 200:
            return web.json_response({"error": "Preset name is too long"}, status=400)

        presets = load_presets()
        presets[name] = {
            "positive": data.get("positive") or "",
            "negative": data.get("negative") or "",
        }
        if not save_presets(presets):
            return web.json_response({"error": "Failed to save"}, status=500)
        return web.json_response({"success": True, "message": f"Preset '{name}' saved"})

    @server.PromptServer.instance.routes.post("/prompt_presets/delete_preset")
    async def delete_preset(request):
        try:
            data = await request.json()
        except ValueError:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        name = str(data.get("name", "")).strip()
        if not name or name == NEW_PRESET_LABEL:
            return web.json_response({"error": "Invalid preset name"}, status=400)

        presets = load_presets()
        if name not in presets:
            return web.json_response({"error": "Preset not found"}, status=404)

        del presets[name]
        if not save_presets(presets):
            return web.json_response({"error": "Failed to save"}, status=500)
        return web.json_response({"success": True, "message": f"Preset '{name}' deleted"})

    @server.PromptServer.instance.routes.post("/prompt_presets/token_count")
    async def token_count(request):
        try:
            data = await request.json()
        except ValueError:
            return web.json_response({"error": "Invalid JSON"}, status=400)

        positive = data.get("positive") or ""
        negative = data.get("negative") or ""
        try:
            positive_count, negative_count = await asyncio.gather(
                asyncio.to_thread(count_tokens, positive),
                asyncio.to_thread(count_tokens, negative),
            )
        except ImportError as exc:
            return web.json_response(
                {"error": f"Qwen tokenizer is not available: {exc}"}, status=501
            )
        except Exception as exc:  # noqa: BLE001 - report any tokenizer failure to the UI
            return web.json_response({"error": str(exc)}, status=500)
        return web.json_response({"positive": positive_count, "negative": negative_count})


class PromptPresetsNode:
    """Positive/negative prompt presets with an optional camera input."""

    @classmethod
    def INPUT_TYPES(cls):
        presets = load_presets()
        preset_names = list(presets.keys()) or ["Default"]

        return {
            "required": {
                "clip": ("CLIP",),
                "preset": (preset_names, {"default": preset_names[0]}),
                "positive": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                }),
                "negative": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                }),
                "preset_name": ("STRING", {
                    "default": "My Preset",
                    "tooltip": "Name written when you press Save Preset",
                }),
            },
            "optional": {
                "camera_input": ("STRING", {
                    "forceInput": True,
                    "tooltip": "Optional STRING prepended to the positive prompt, e.g. a camera description",
                }),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "process"
    CATEGORY = "conditioning"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs):
        # The preset dropdown is built from a file that can change while a workflow
        # is open, so a name that no longer exists must not block queueing.
        return True

    @classmethod
    def IS_CHANGED(cls, preset, **kwargs):
        return preset

    @classmethod
    def load_presets(cls):
        return load_presets()

    @classmethod
    def save_presets(cls, presets):
        return save_presets(presets)

    def process(self, clip, preset, positive, negative, camera_input=None, preset_name="My Preset"):
        # The JSON file is authoritative; widget values are only a fallback for a
        # preset that was deleted after the workflow was saved.
        presets = self.load_presets()
        if preset in presets:
            preset_data = presets[preset]
            positive = preset_data.get("positive") or ""
            negative = preset_data.get("negative") or ""
            LOGGER.info(
                "PromptPresets: preset %r (positive: %d chars, negative: %d chars)",
                preset, len(positive), len(negative),
            )
        else:
            LOGGER.warning(
                "PromptPresets: preset %r not found in %s, using widget values",
                preset, PRESETS_FILE,
            )

        final_positive = positive
        camera = (camera_input or "").strip()
        if camera:
            final_positive = f"{camera}\n\n{positive}"

        # Same two-step encoding CLIPTextEncode uses.
        conditioning_positive = clip.encode_from_tokens_scheduled(clip.tokenize(final_positive))
        conditioning_negative = clip.encode_from_tokens_scheduled(clip.tokenize(negative))
        return (conditioning_positive, conditioning_negative)


NODE_CLASS_MAPPINGS = {
    "PromptPresetsNode": PromptPresetsNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptPresetsNode": "Prompt Presets",
}
