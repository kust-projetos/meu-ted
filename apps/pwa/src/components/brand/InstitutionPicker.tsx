"use client";

import { useId, useMemo, useRef, useState } from "react";
import { searchInstitutions, type Institution } from "@/lib/institutions/catalog";
import { InstitutionMark } from "./InstitutionMark";

interface InstitutionPickerProps {
  value?: Institution;
  onSelect: (institution: Institution) => void;
  onManual: (name: string) => void;
  className?: string;
}

export function InstitutionPicker({
  value,
  onSelect,
  onManual,
  className = "",
}: InstitutionPickerProps) {
  const id = useId();
  const [queryState, setQueryState] = useState({ valueKey: "", text: "" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [manual, setManual] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const valueKey = value ? `${value.id}:${value.name}` : "";
  const query = queryState.valueKey === valueKey ? queryState.text : "";
  const options = useMemo(() => searchInstitutions(query, 40), [query]);
  const manualName = query.trim();
  const optionCount = options.length + (manualName ? 1 : 0);

  const chooseOption = (index: number) => {
    if (index < options.length) {
      onSelect(options[index]);
      setQueryState({ valueKey, text: "" });
      setManual(false);
      setOpen(false);
      return;
    }
    if (manualName) {
      onManual(manualName);
      setManual(true);
      setOpen(false);
    }
  };

  const commitManualName = () => {
    if (!manualName) return;
    onManual(manualName);
    setManual(true);
    setOpen(false);
  };

  return (
    <div className={`relative ${className}`}>
      <label htmlFor={`${id}-input`} className="mb-1.5 block text-sm font-medium text-text-primary">
        Instituição
      </label>
      <input
        ref={input}
        id={`${id}-input`}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && active >= 0 ? `${id}-option-${active}` : undefined}
        value={open ? query : value?.name ?? (manual ? query : "")}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQueryState({ valueKey, text: event.target.value });
          setActive(-1);
          setOpen(true);
          setManual(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(optionCount - 1, current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (active >= 0 && active < optionCount) chooseOption(active);
            else commitManualName();
          } else if (event.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
        className="min-h-11 w-full rounded-xl border border-border-medium bg-surface-1 px-3 text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary"
        placeholder="Buscar instituição"
      />
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border-medium bg-surface-1 p-1 shadow-elevated"
        >
          {options.map((institution, index) => (
            <li
              id={`${id}-option-${index}`}
              key={institution.id}
              role="option"
              aria-selected={value?.id === institution.id}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => chooseOption(index)}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-text-primary ${
                index === active ? "bg-surface-3" : ""
              }`}
            >
              <InstitutionMark institution={institution} size="sm" />
              <span>{institution.name}</span>
              {institution.popular && <span className="ml-auto text-xs text-text-muted">Popular</span>}
            </li>
          ))}
          {manualName && (
            <li
              id={`${id}-option-${options.length}`}
              role="option"
              aria-selected={active === options.length}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(options.length)}
              onClick={() => chooseOption(options.length)}
              className={`flex min-h-11 cursor-pointer items-center px-3 text-text-primary ${
                active === options.length ? "bg-surface-3" : ""
              }`}
            >
              Outra instituição: “{manualName}”
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
