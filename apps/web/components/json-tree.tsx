"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string")
    return <span className="json-string">{JSON.stringify(value)}</span>;
  if (typeof value === "number")
    return <span className="json-number">{String(value)}</span>;
  if (typeof value === "boolean")
    return <span className="json-boolean">{String(value)}</span>;
  return <span className="json-null">null</span>;
}

function Node({
  name,
  index,
  value,
  depth,
  last,
}: {
  name?: string;
  index?: number;
  value: unknown;
  depth: number;
  last: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isContainer = value !== null && typeof value === "object";

  const label = (
    <>
      {name !== undefined && (
        <>
          <span className="json-key">&quot;{name}&quot;</span>
          <span className="text-muted-foreground">: </span>
        </>
      )}
      {index !== undefined && (
        <span className="text-muted-foreground/60">{index}: </span>
      )}
    </>
  );
  const comma = !last && <span className="text-muted-foreground">,</span>;

  if (!isContainer) {
    return (
      <div className="break-all whitespace-pre-wrap">
        {label}
        <Primitive value={value} />
        {comma}
      </div>
    );
  }

  const array = Array.isArray(value);
  const entries = array
    ? (value as unknown[]).map((v, i) => [i, v] as const)
    : Object.entries(value as Record<string, unknown>);
  const [openCh, closeCh] = array ? ["[", "]"] : ["{", "}"];

  if (entries.length === 0) {
    return (
      <div>
        {label}
        {openCh}
        {closeCh}
        {comma}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group cursor-pointer text-left"
        title={open ? "Collapse" : "Expand"}
      >
        <span
          className={cn(
            "mr-1 inline-block w-3 text-muted-foreground transition-colors select-none group-hover:text-foreground",
            open && "rotate-90"
          )}
        >
          ▸
        </span>
        {label}
        {open ? (
          openCh
        ) : (
          <>
            {openCh}…{closeCh}
            {comma}
            <span className="ml-2 text-muted-foreground/60">
              {entries.length}{" "}
              {array
                ? entries.length === 1
                  ? "item"
                  : "items"
                : entries.length === 1
                  ? "key"
                  : "keys"}
            </span>
          </>
        )}
      </button>
      {open && (
        <>
          <div className="ml-[5px] border-l border-border pl-4">
            {entries.map(([key, child], i) => (
              <Node
                key={key}
                name={array ? undefined : (key as string)}
                index={array ? (key as number) : undefined}
                value={child}
                depth={depth + 1}
                last={i === entries.length - 1}
              />
            ))}
          </div>
          <div>
            <span className="mr-1 inline-block w-3" />
            {closeCh}
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="json-tree overflow-x-auto rounded-lg border bg-muted/40 px-4 py-3 text-[13px] leading-relaxed">
      <Node value={value} depth={0} last />
    </div>
  );
}
