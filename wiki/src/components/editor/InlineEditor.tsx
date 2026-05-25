"use client";

import { useEffect, useRef } from "react";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/react";

type InlineEditorProps = {
  content: string;
  onChange: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
  /**
   * Fired once when the editor has mounted and produced its first
   * round-tripped HTML. The caller should reseat any "baseline" copy
   * of the content to this value, because Tiptap normalizes input on
   * load (StarterKit strips unknown tags, reformats whitespace, etc.)
   * so the raw HTML we passed in does not match what the editor will
   * report on subsequent updates. Without this, isDirty fires as soon
   * as the editor mounts.
   */
  onReady?: (initialHtml: string) => void;
};

/**
 * Inline, chromeless Tiptap editor.
 *
 * Renders the passed HTML/markdown-as-html with the same typography as the
 * read-mode article, and lets the user click anywhere to edit in place.
 * No toolbar, no border, no background — it looks like editing the page.
 */
export default function InlineEditor({
  content,
  onChange,
  editable = true,
  placeholder = "Write something...",
  onReady,
}: InlineEditorProps) {
  // Keep the latest onReady in a ref so we can fire it from onCreate
  // without rebuilding the editor every time the prop reference changes.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
    ],
    content,
    editable,
    immediatelyRender: false,
    onCreate: ({ editor: instance }) => {
      onReadyRef.current?.(instance.getHTML());
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() === content) return;
    editor.commands.setContent(content, { emitUpdate: false });
  }, [editor, content]);

  if (!editor) return null;

  // Reuse `.wiki-richtext-editor` so the ProseMirror surface inherits the
  // exact same prose styles as `.wiki-richtext-rendered`. No wrapper chrome.
  return (
    <EditorContent
      editor={editor}
      className="wiki-richtext-editor wiki-richtext-rendered"
    />
  );
}
