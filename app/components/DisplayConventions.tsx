"use client";

import { useEffect } from "react";

const LEGACY_MONEY = /(-?\d{1,3}(?:\.\d{3})+|-?\d+)\s+đ(?!ồng)/g;

function normalizeMoneyText(value: string) {
  return value.replace(LEGACY_MONEY, (_, raw: string) => `${raw.replaceAll(".", ",")} đồng`);
}

function normalizeNode(root: Node) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    if (current instanceof Text && current.parentElement && !["SCRIPT", "STYLE"].includes(current.parentElement.tagName)) nodes.push(current);
    current = walker.nextNode();
  }
  for (const node of nodes) {
    const next = normalizeMoneyText(node.data);
    if (next !== node.data) node.data = next;
  }
}

export default function DisplayConventions() {
  useEffect(() => {
    normalizeNode(document.body);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) normalizeNode(node);
        if (mutation.type === "characterData" && mutation.target.parentNode) normalizeNode(mutation.target.parentNode);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
