"use client";

import { useEffect } from "react";

const LEGACY_MONEY = /(-?\d{1,3}(?:\.\d{3})+|-?\d+)\s+đ(?!ồng)/g;

function normalizeMoneyText(value: string) {
  return value.replace(LEGACY_MONEY, (_, raw: string) => `${raw.replaceAll(".", ",")} đồng`);
}

function normalizeText(node: Text) {
  if (!node.parentElement || ["SCRIPT", "STYLE"].includes(node.parentElement.tagName)) return;
  const next = normalizeMoneyText(node.data);
  if (next !== node.data) node.data = next;
}

function normalizeNode(root: Node) {
  if (root instanceof Text) {
    normalizeText(root);
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text) normalizeText(current);
    current = walker.nextNode();
  }
}

export default function DisplayConventions() {
  useEffect(() => {
    normalizeNode(document.body);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) normalizeNode(node);
        if (mutation.type === "characterData") normalizeNode(mutation.target);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
