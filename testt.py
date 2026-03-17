import json
import logging
import os
from pathlib import Path

import requests


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
)
logger = logging.getLogger(__name__)

URL = "https://api.x.ai/v1/responses"
MODEL = "grok-4.20-multi-agent-beta-0309"
FILE_PATH = Path(r"C:\Users\lewka\deep_learning\tiny_mixer\journal_results_section.md")


def extract_output_text(response_json: dict) -> str:
    output_items = response_json.get("output", [])
    for item in output_items:
        if item.get("type") != "message":
            continue
        for content_item in item.get("content", []):
            if content_item.get("type") == "output_text":
                return content_item.get("text", "")
    return ""


def main() -> None:
    api_key = os.getenv("XAI_API_KEY") or os.getenv("GROK_API_KEY")
    if not api_key:
        raise RuntimeError("Set XAI_API_KEY or GROK_API_KEY in your environment before running this script.")

    if not FILE_PATH.exists():
        raise FileNotFoundError(f"Markdown file not found: {FILE_PATH}")

    logger.info("Reading markdown file: %s", FILE_PATH)
    file_text = FILE_PATH.read_text(encoding="utf-8")
    logger.info("Loaded %s characters from markdown file", len(file_text))

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    payload = {
        "model": MODEL,
        "reasoning": {"effort": "xhigh"},
        "input": [
            {
                "role": "user",
                "content": (
                    "Analyze the following markdown document. "
                    "Rate it from 1 to 10, explain the rating, say what you agree with, "
                    "what you disagree with, and why.\n\n"
                    "what to improve, and how to improve it. Be specific and detailed in your analysis.\n\n"
                    "give me the full section of the journal that you would write based on this markdown, and explain why you would write it that way.\n\n "
                    f"Source path: {FILE_PATH}\n\n"
                    "Document content:\n"
                    f"{file_text}"
                ),
            }
        ],
    }

    logger.info("Sending request to xAI Responses API with model %s", MODEL)
    response = requests.post(URL, headers=headers, json=payload, timeout=600)
    logger.info("Received HTTP status: %s", response.status_code)
    response.raise_for_status()

    response_json = response.json()
    logger.info("Response id: %s", response_json.get("id"))
    logger.info("Usage: %s", json.dumps(response_json.get("usage", {}), indent=2))

    output_text = extract_output_text(response_json)
    if output_text:
        print(output_text)
    else:
        logger.warning("No output_text found. Printing raw JSON response.")
        print(json.dumps(response_json, indent=2))


if __name__ == "__main__":
    main()
