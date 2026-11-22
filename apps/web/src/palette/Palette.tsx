// Ctrl K (or "/") goes anywhere (Run 9.0 Task G, D-70): a modal dialog with
// a combobox and a listbox (aria-activedescendant). Arrow keys choose, Enter
// goes, Escape closes and gives the focus back. Its entries are
// palette/sources.ts's: places and actions, never a secret. What is typed is
// kept only while the dialog is open.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { navigate } from "../router.tsx";
import { ask } from "../state/intent.ts";
import type { Scope } from "../state/scope.tsx";
import { Icon } from "../ui/icons.tsx";
import { matchEntries, paletteEntries, type PaletteEntry } from "./sources.ts";

const KIND_TEXT: Readonly<Record<PaletteEntry["kind"], string>> = {
  page: "Page",
  project: "Project",
  environment: "Environment",
  help: "Help",
  action: "Action",
};

const SHOWN = 12;

function Dialog(props: { scope: Scope | null; onClose: () => void; onSignOut: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useId();
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  const all = paletteEntries(props.scope);
  const found = (
    typed.trim() === "" ? all.filter((e) => e.kind !== "help") : matchEntries(all, typed)
  ).slice(0, SHOWN);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    input.current?.focus();
    return () => {
      if (element?.open === true) element.close();
    };
  }, []);

  const go = (entry: PaletteEntry | undefined): void => {
    if (entry === undefined) return;
    props.onClose();
    if (entry.run === "new-project") {
      ask("new-project");
      const home = all.find((candidate) => candidate.label === "Home");
      if (home?.to !== undefined) navigate(home.to);
    } else if (entry.run === "sign-out") {
      props.onSignOut();
    } else if (entry.to !== undefined) {
      navigate(entry.to);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((at) => Math.min(at + 1, Math.max(found.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(found[active]);
    }
  };

  const optionId = (index: number): string => `${list}-${String(index)}`;
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Go to"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop (the dialog itself, outside its content) closes it.
        if (event.target === dialog.current) props.onClose();
      }}
    >
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-label="Go to a page, a project, an environment, a help article or an action"
        aria-expanded="true"
        aria-controls={list}
        aria-autocomplete="list"
        aria-activedescendant={found[active] === undefined ? undefined : optionId(active)}
        placeholder="Go to…"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      {found.length === 0 ? (
        <p className="none" role="status">
          Nothing matches. The palette finds pages, projects, environments, help and actions; it
          never searches secrets.
        </p>
      ) : null}
      <ul id={list} role="listbox" aria-label="Places and actions">
        {found.map((entry, index) => (
          <li
            key={`${entry.kind} ${entry.label} ${entry.to ?? entry.run ?? ""}`}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => {
              setActive(index);
            }}
            onClick={() => {
              go(entry);
            }}
          >
            <span>{entry.label}</span>
            <span className="kind">{KIND_TEXT[entry.kind]}</span>
          </li>
        ))}
      </ul>
    </dialog>
  );
}

/** The top bar's search button, and Ctrl K / "/" anywhere a field does not have the keys. */
export function Palette(props: { scope: Scope | null; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      } else if (
        event.key === "/" &&
        !typing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <>
      <button
        type="button"
        className="search-button"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Icon name="search" />
        <span className="label">Go to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      {open ? (
        <Dialog
          scope={props.scope}
          onClose={() => {
            setOpen(false);
          }}
          onSignOut={props.onSignOut}
        />
      ) : null}
    </>
  );
}
