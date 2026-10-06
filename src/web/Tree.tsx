import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useRef } from "react";

const TREE_CSS = `
  button[data-type='item'] { border-radius: 0 !important; }
`;

export function Tree({
  paths,
  gitStatus,
  selected,
  onSelect,
}: {
  paths: string[];
  gitStatus?: GitStatusEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const files = useRef(new Set(paths));
  files.current = new Set(paths);
  const select = useRef(onSelect);
  select.current = onSelect;

  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    unsafeCSS: TREE_CSS,
    onSelectionChange: (selection) => {
      const path = selection[selection.length - 1];
      if (path && files.current.has(path)) select.current(path);
    },
  });

  useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  useEffect(() => {
    if (selected) model.scrollToPath(selected, { focus: false });
  }, [model, selected]);

  return <FileTree model={model} className="tree" style={{ height: "100%" }} />;
}
