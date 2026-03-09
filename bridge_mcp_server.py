#!/usr/bin/env python3
"""Explicit Feishu file delivery MCP server for feicodex-rocket-bridge."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests


SERVER_NAME = "feishu-bridge-files"
SERVER_VERSION = "0.1.0"
FEISHU_API = "https://open.feishu.cn/open-apis"
FEISHU_FILE_UPLOAD_MAX_SIZE_MB = 30


def _env(name: str, default: str = "") -> str:
    return str(os.getenv(name, default) or "").strip()


def _content_text(text: str, is_error: bool = False) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "isError": bool(is_error)}


def _json_text(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2)


FEISHU_APP_ID = _env("FEISHU_APP_ID")
FEISHU_APP_SECRET = _env("FEISHU_APP_SECRET")
STATE_PATH = _env("BRIDGE_STATE_PATH", "")
DEFAULT_CHAT_ID = _env("BRIDGE_MCP_DEFAULT_CHAT_ID", _env("BRIDGE_DEFAULT_CHAT_ID", ""))
DEFAULT_PROJECT = _env("BRIDGE_MCP_DEFAULT_PROJECT", "")
DEFAULT_RUNTIME_CWD = _env("BRIDGE_MCP_RUNTIME_CWD", "")
ALLOWED_DIRS_RAW = _env("BRIDGE_MCP_FILE_ALLOWED_DIRS", "")
FILE_MAX_SIZE_MB = min(
    FEISHU_FILE_UPLOAD_MAX_SIZE_MB,
    max(1, int(_env("BRIDGE_MCP_FILE_MAX_SIZE_MB", str(FEISHU_FILE_UPLOAD_MAX_SIZE_MB)))),
)

TOOLS: List[Dict[str, Any]] = [
    {
        "name": "feishu_send_file",
        "description": "Send one local file back to the current Feishu chat explicitly.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "display_name": {"type": "string"},
                "chat_id": {"type": "string"},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "feishu_send_files",
        "description": "Send multiple local files back to the current Feishu chat explicitly.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"}},
                "chat_id": {"type": "string"},
            },
            "required": ["paths"],
            "additionalProperties": False,
        },
    },
]

_TOKEN_CACHE: Dict[str, Any] = {"token": "", "expires_at": 0.0}


def _load_state() -> Dict[str, Any]:
    path = Path(STATE_PATH)
    if not STATE_PATH or not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _latest_chat_id_from_state() -> str:
    state = _load_state()
    chats = state.get("chats")
    if not isinstance(chats, dict):
        return ""
    best_chat = ""
    best_ts = -1
    for key, item in chats.items():
        if not isinstance(item, dict):
            continue
        chat_id = str(item.get("source_chat_id") or key or "").strip()
        if not chat_id or chat_id == "dummy":
            continue
        ts = int(item.get("updated_at") or item.get("last_input_at") or 0)
        if ts > best_ts:
            best_ts = ts
            best_chat = chat_id
    return best_chat


def _resolve_chat_id(given_chat_id: str = "") -> str:
    cid = str(given_chat_id or "").strip()
    if cid:
        return cid
    if DEFAULT_CHAT_ID:
        return DEFAULT_CHAT_ID
    return _latest_chat_id_from_state()


def _allowed_roots() -> List[Path]:
    roots: List[Path] = []
    if ALLOWED_DIRS_RAW:
        for item in ALLOWED_DIRS_RAW.split(","):
            raw = str(item or "").strip()
            if raw:
                roots.append(Path(raw).expanduser().resolve())
    elif DEFAULT_RUNTIME_CWD:
        roots.append(Path(DEFAULT_RUNTIME_CWD).expanduser().resolve())
    return roots


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except Exception:
        return False


def _normalize_send_path(raw_path: str) -> Path:
    base = Path(DEFAULT_RUNTIME_CWD).expanduser().resolve() if DEFAULT_RUNTIME_CWD else Path.cwd()
    path = Path(str(raw_path or "").strip()).expanduser()
    if not path.is_absolute():
        path = base / path
    resolved = path.resolve()
    roots = _allowed_roots()
    if roots and not any(_is_under(resolved, root) for root in roots):
        raise RuntimeError(f"path outside allowed roots: {resolved}")
    if not resolved.exists() or not resolved.is_file():
        raise RuntimeError(f"file not found: {resolved}")
    size = resolved.stat().st_size
    if size > FILE_MAX_SIZE_MB * 1024 * 1024:
        raise RuntimeError(f"file too large: {resolved.name} ({size} bytes)")
    return resolved


def _tenant_access_token() -> str:
    now = time.time()
    cached = str(_TOKEN_CACHE.get("token") or "")
    if cached and float(_TOKEN_CACHE.get("expires_at") or 0) > now + 60:
        return cached
    if not FEISHU_APP_ID or not FEISHU_APP_SECRET:
        raise RuntimeError("FEISHU_APP_ID/FEISHU_APP_SECRET missing")
    response = requests.post(
        f"{FEISHU_API}/auth/v3/tenant_access_token/internal",
        json={"app_id": FEISHU_APP_ID, "app_secret": FEISHU_APP_SECRET},
        timeout=20,
    )
    if response.status_code >= 300:
        raise RuntimeError(f"tenant token failed status={response.status_code} body={response.text}")
    payload = response.json()
    if payload.get("code") not in (0, None):
        raise RuntimeError(f"tenant token feishu err: {payload}")
    token = str(payload.get("tenant_access_token") or "").strip()
    expire = int(payload.get("expire") or 7200)
    if not token:
        raise RuntimeError(f"tenant token missing: {payload}")
    _TOKEN_CACHE["token"] = token
    _TOKEN_CACHE["expires_at"] = now + max(300, expire)
    return token


def _send_file_to_chat(chat_id: str, file_path: Path, display_name: str = "") -> Dict[str, Any]:
    token = _tenant_access_token()
    with file_path.open("rb") as handle:
        upload_resp = requests.post(
            f"{FEISHU_API}/im/v1/files",
            headers={"Authorization": f"Bearer {token}"},
            data={"file_type": "stream", "file_name": str(display_name or file_path.name)},
            files={"file": (str(display_name or file_path.name), handle)},
            timeout=60,
        )
    if upload_resp.status_code >= 300:
        raise RuntimeError(f"upload_file failed status={upload_resp.status_code} body={upload_resp.text}")
    upload_data = upload_resp.json()
    if upload_data.get("code") != 0:
        raise RuntimeError(f"upload_file feishu err: {upload_data}")
    file_key = str((upload_data.get("data") or {}).get("file_key") or "").strip()
    if not file_key:
        raise RuntimeError(f"upload_file missing file_key: {upload_data}")

    send_resp = requests.post(
        f"{FEISHU_API}/im/v1/messages?receive_id_type=chat_id",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "receive_id": str(chat_id or ""),
            "msg_type": "file",
            "content": json.dumps({"file_key": file_key}, ensure_ascii=False),
        },
        timeout=20,
    )
    if send_resp.status_code >= 300:
        raise RuntimeError(f"send_file failed status={send_resp.status_code} body={send_resp.text}")
    send_data = send_resp.json()
    if send_data.get("code") != 0:
        raise RuntimeError(f"send_file feishu err: {send_data}")
    return {
        "name": str(display_name or file_path.name),
        "path": str(file_path),
        "message_id": str((send_data.get("data") or {}).get("message_id") or "").strip(),
    }


def _dispatch_tool(name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    target_chat = _resolve_chat_id(str(args.get("chat_id") or ""))
    if not target_chat:
        return {"ok": False, "error": "cannot resolve target Feishu chat_id"}
    if name == "feishu_send_file":
        path = _normalize_send_path(str(args.get("path") or ""))
        item = _send_file_to_chat(
            chat_id=target_chat,
            file_path=path,
            display_name=str(args.get("display_name") or "").strip(),
        )
        return {"ok": True, "chat_id": target_chat, "project": DEFAULT_PROJECT, "sent": [item]}
    if name == "feishu_send_files":
        raw_paths = args.get("paths") if isinstance(args.get("paths"), list) else []
        sent: List[Dict[str, Any]] = []
        for raw in raw_paths:
            path = _normalize_send_path(str(raw or ""))
            sent.append(_send_file_to_chat(chat_id=target_chat, file_path=path, display_name=path.name))
        return {"ok": True, "chat_id": target_chat, "project": DEFAULT_PROJECT, "sent": sent}
    return {"ok": False, "error": f"unknown tool: {name}"}


def _read_request() -> Optional[Dict[str, Any]]:
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return None
    return json.loads(line)


def _write_response(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle_request(req: Dict[str, Any]) -> Dict[str, Any]:
    req_id = req.get("id")
    method = str(req.get("method") or "")
    params = req.get("params") if isinstance(req.get("params"), dict) else {}

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "capabilities": {"tools": {"listChanged": False}},
            },
        }
    if method == "notifications/initialized":
        return {"jsonrpc": "2.0", "id": req_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = str(params.get("name") or "")
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        out = _dispatch_tool(name, args)
        is_error = not bool(out.get("ok"))
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {"content": [_content_text(_json_text(out), is_error=is_error)], "isError": is_error},
        }
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method not found: {method}"},
    }


def main() -> int:
    while True:
        try:
            req = _read_request()
        except Exception as exc:
            _write_response({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
            continue
        if req is None:
            return 0
        try:
            _write_response(_handle_request(req))
        except Exception as exc:
            _write_response({"jsonrpc": "2.0", "id": req.get("id"), "error": {"code": -32000, "message": str(exc)}})


if __name__ == "__main__":
    raise SystemExit(main())
