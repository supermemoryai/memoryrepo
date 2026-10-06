import {
  Command,
  CustomKeymap,
  EditorBubble,
  EditorBubbleItem,
  EditorCommand,
  EditorCommandEmpty,
  EditorCommandItem,
  EditorCommandList,
  EditorContent,
  EditorRoot,
  GlobalDragHandle,
  HighlightExtension,
  HorizontalRule,
  Placeholder,
  StarterKit,
  TaskItem,
  TaskList,
  TiptapLink,
  TiptapUnderline,
  createSuggestionItems,
  handleCommandNavigation,
  renderItems,
  type EditorInstance,
} from "novel";
import {
  BoldIcon,
  CodeIcon,
  CodeXmlIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  HighlighterIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  MinusIcon,
  QuoteIcon,
  StrikethroughIcon,
  TextIcon,
  UnderlineIcon,
} from "lucide-react";
import { Markdown as MarkdownExtension } from "tiptap-markdown";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note, NoteSummary } from "../server/memory-agent.ts";
import type { Memory } from "./App.tsx";
import { ago } from "./format.ts";

// ---- editor setup (the editor experience follows notty: github.com/Dhravya/notty) ----

const suggestionItems = createSuggestionItems([
  { title: "Text", description: "Plain paragraph", icon: <TextIcon size={16} />, searchTerms: ["p", "paragraph"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleNode("paragraph", "paragraph").run() },
  { title: "Heading 1", description: "Large section heading", icon: <Heading1Icon size={16} />, searchTerms: ["title", "big"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run() },
  { title: "Heading 2", description: "Medium section heading", icon: <Heading2Icon size={16} />, searchTerms: ["subtitle"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run() },
  { title: "Heading 3", description: "Small section heading", icon: <Heading3Icon size={16} />, searchTerms: ["small"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 3 }).run() },
  { title: "Bullet list", description: "Unordered list", icon: <ListIcon size={16} />, searchTerms: ["unordered", "bullet"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run() },
  { title: "Numbered list", description: "Ordered list", icon: <ListOrderedIcon size={16} />, searchTerms: ["ordered", "number"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { title: "To-do list", description: "Track tasks with checkboxes", icon: <ListTodoIcon size={16} />, searchTerms: ["todo", "task", "checkbox"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run() },
  { title: "Quote", description: "Block quote", icon: <QuoteIcon size={16} />, searchTerms: ["blockquote"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run() },
  { title: "Code block", description: "Monospaced code", icon: <CodeXmlIcon size={16} />, searchTerms: ["code", "codeblock"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run() },
  { title: "Divider", description: "Horizontal rule", icon: <MinusIcon size={16} />, searchTerms: ["hr", "divider", "separator"], command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run() },
]);

const extensions = [
  StarterKit.configure({ horizontalRule: false, dropcursor: { color: "var(--accent)", width: 2 } }),
  TiptapLink.configure({ HTMLAttributes: { class: "note-link" } }),
  Placeholder.configure({
    placeholder: ({ node }) => (node.type.name === "heading" ? `Heading ${node.attrs.level}` : "Write, or press '/' for commands…"),
    showOnlyCurrent: true,
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  HorizontalRule,
  TiptapUnderline,
  HighlightExtension,
  CustomKeymap,
  GlobalDragHandle,
  Command.configure({ suggestion: { items: () => suggestionItems, render: renderItems } }),
  // Notes are stored as markdown, so dreaming and the API read plain text.
  MarkdownExtension.configure({ html: false, tightLists: true, transformPastedText: true }),
];

const markdownOf = (editor: EditorInstance) => (editor.storage as { markdown: { getMarkdown(): string } }).markdown.getMarkdown();

// ---- view --------------------------------------------------------------------------

/**
 * Notes: the user's own writing (journal, lists, plans). They aren't memory themselves; the next
 * dream reads new or edited notes and folds what's durable into the memory repo, citing note/<id>.
 */
export function NotesView({ memory, openNote, dreamingAt }: { memory: Memory; openNote?: string | null; dreamingAt?: number | null }) {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(openNote ?? null);

  const refresh = useCallback(async () => {
    const list = await memory.stub.listNotes();
    setNotes(list);
    return list;
  }, [memory]);

  useEffect(() => {
    void refresh().then((list) => setSelected((cur) => openNote ?? cur ?? list[0]?.id ?? null));
  }, [refresh, openNote, dreamingAt]);

  const create = async () => {
    const note = await memory.stub.saveNote({ title: "Untitled", body: "" });
    await refresh();
    setSelected(note.id);
  };

  return (
    <div className="split notes">
      <div className="split-side">
        <div className="pane-head mono">
          notes · {notes.length}
          <button className="seg-btn graph-open" onClick={() => void create()}>
            + new
          </button>
        </div>
        <ul className="notes-list">
          {notes.length === 0 && (
            <li className="muted pad notes-empty">Notes are your own writing: a journal, a list, a plan. The next dream folds what matters into memory.</li>
          )}
          {notes.map((n) => (
            <li key={n.id}>
              <button className={`thread ${n.id === selected ? "active" : ""}`} onClick={() => setSelected(n.id)}>
                <span className="thread-title">{n.title}</span>
                <span className="thread-meta mono">
                  <span className={`note-state ${n.dreamed ? "in" : "pending"}`} title={n.dreamed ? "in memory (dreamt)" : "changed since the last dream"} />
                  {ago(n.updated_at)} · {n.chars.toLocaleString()} chars
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="split-main">
        {selected ? (
          <NoteEditor
            key={selected}
            memory={memory}
            id={selected}
            onSaved={() => void refresh()}
            onDeleted={async () => {
              const list = await refresh();
              setSelected(list[0]?.id ?? null);
            }}
          />
        ) : (
          <div className="empty center">
            <div className="empty-title">no note selected</div>
            <button className="btn btn-primary" onClick={() => void create()}>
              + New note
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteEditor({ memory, id, onSaved, onDeleted }: { memory: Memory; id: string; onSaved: () => void; onDeleted: () => void }) {
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"saved" | "saving" | "dirty">("saved");
  const editorRef = useRef<EditorInstance | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;

  useEffect(() => {
    void memory.stub.getNote(id).then((n) => {
      setNote(n);
      setTitle(n?.title === "Untitled" ? "" : (n?.title ?? ""));
    });
  }, [memory, id]);

  // Debounced autosave of title + markdown body.
  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setStatus("dirty");
    timer.current = setTimeout(async () => {
      const editor = editorRef.current;
      if (!editor) return;
      setStatus("saving");
      const saved = await memory.stub.saveNote({ id, title: titleRef.current.trim() || "Untitled", body: markdownOf(editor) });
      setNote(saved);
      setStatus("saved");
      onSaved();
    }, 700);
  }, [memory, id, onSaved]);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const bubble = useMemo(
    () => [
      { icon: <BoldIcon size={14} />, run: (e: EditorInstance) => e.chain().focus().toggleBold().run(), label: "bold" },
      { icon: <ItalicIcon size={14} />, run: (e: EditorInstance) => e.chain().focus().toggleItalic().run(), label: "italic" },
      { icon: <UnderlineIcon size={14} />, run: (e: EditorInstance) => e.chain().focus().toggleUnderline().run(), label: "underline" },
      { icon: <StrikethroughIcon size={14} />, run: (e: EditorInstance) => e.chain().focus().toggleStrike().run(), label: "strike" },
      { icon: <CodeIcon size={14} />, run: (e: EditorInstance) => e.chain().focus().toggleCode().run(), label: "code" },
      { icon: <HighlighterIcon size={14} />, run: (e: EditorInstance) => e.chain().focus().toggleHighlight().run(), label: "highlight" },
    ],
    [],
  );

  if (!note) return <div className="muted mono pad">loading…</div>;

  return (
    <div className="note">
      <div className="pane-head file-head">
        <span className="mono">
          note/{note.id} · {status === "saved" ? `saved ${ago(note.updated_at)}` : status === "saving" ? "saving…" : "editing…"}
        </span>
        <button
          className="seg-btn graph-open"
          onClick={async () => {
            if (!confirm("Delete this note? Memory already dreamt from it stays.")) return;
            await memory.stub.deleteNote(note.id);
            onDeleted();
          }}
        >
          delete
        </button>
      </div>
      <div className="note-scroll">
        <div className="note-inner">
          <input
            className="note-title"
            placeholder="Untitled"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              save();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                editorRef.current?.commands.focus("start");
              }
            }}
          />
          <EditorRoot>
            <EditorContent
              className="note-editor"
              extensions={extensions}
              immediatelyRender={false}
              onCreate={({ editor }) => {
                editorRef.current = editor;
                editor.commands.setContent(note.body); // markdown → doc via tiptap-markdown
              }}
              onUpdate={({ editor }) => {
                editorRef.current = editor;
                save();
              }}
              editorProps={{
                handleDOMEvents: { keydown: (_view, event) => handleCommandNavigation(event) },
                attributes: { class: "note-prose" },
              }}
            >
              <EditorCommand className="slash-menu">
                <EditorCommandEmpty className="slash-empty mono">no results</EditorCommandEmpty>
                <EditorCommandList>
                  {suggestionItems.map((item) => (
                    <EditorCommandItem key={item.title} value={item.title} onCommand={(val) => item.command?.(val)} className="slash-item">
                      <span className="slash-icon">{item.icon}</span>
                      <span>
                        <span className="slash-title">{item.title}</span>
                        <span className="slash-desc">{item.description}</span>
                      </span>
                    </EditorCommandItem>
                  ))}
                </EditorCommandList>
              </EditorCommand>
              <EditorBubble className="bubble-menu">
                {bubble.map((b) => (
                  <EditorBubbleItem key={b.label} onSelect={(editor) => b.run(editor)}>
                    <button className="bubble-btn" title={b.label}>
                      {b.icon}
                    </button>
                  </EditorBubbleItem>
                ))}
              </EditorBubble>
            </EditorContent>
          </EditorRoot>
        </div>
      </div>
      <div className="note-foot mono">
        markdown · {(note.body.length || 0).toLocaleString()} chars · the next dream reads new or edited notes and folds what's durable into memory
      </div>
    </div>
  );
}
