import { createMemo, createSignal, createUniqueId, For } from "solid-js";
import type { JSX } from "solid-js";

import { Icon } from "./icons";
import type { IconName } from "./icons";

export type CategoryItem = {
  label: string;
  render: () => JSX.Element;
};

type DialogCategory = {
  title: string;
  icon?: IconName;
} & ({ items: CategoryItem[] } | { keywords?: string; content: () => JSX.Element });

// All category dialogs share navigation, section spacing, search, and scrolling.
export const CategoryBrowser = (props: {
  readonly label: string;
  readonly categories: DialogCategory[];
  readonly filterTabs?: boolean;
}): JSX.Element => {
  const [tab, setTab] = createSignal("All");
  const [search, setSearch] = createSignal("");
  let page: HTMLDivElement | null = null;
  const id = createUniqueId();
  const query = createMemo(() => search().trim().toLowerCase());
  const activeTab = createMemo(() => (props.filterTabs === true && query() !== "" ? "All" : tab()));
  const matches = (label: string): boolean => label.toLowerCase().includes(query());
  const categories = createMemo(() => props.categories);
  const tabs = createMemo(() => [
    {
      title: "All",
      icon: categories().some((category) => category.icon) ? ("category" as const) : undefined,
    },
    ...categories().filter((category) => props.filterTabs !== true || matches(category.title)),
  ]);
  const visible = createMemo(() =>
    categories().filter(
      (category) =>
        (activeTab() === "All" || activeTab() === category.title) &&
        (query() === "" ||
          ("items" in category
            ? category.items.some((item) => matches(item.label))
            : matches(`${category.title} ${category.keywords ?? ""}`))),
    ),
  );
  return (
    <div class="category-browser">
      <input
        type="search"
        class="control category-search"
        aria-label={`Search ${props.label.toLowerCase()}`}
        placeholder="Search"
        value={search()}
        onInput={(event) => {
          setSearch(event.target.value);
          if (page) {
            page.scrollTop = 0;
          }
        }}
      />
      <div class="category-layout">
        <nav class="dialog-tabs" aria-label={props.label}>
          {tabs().map(({ title, icon }) => (
            <button
              type="button"
              class="control toggle-button"
              aria-pressed={activeTab() === title}
              aria-controls={id}
              onClick={() => {
                setTab(title);
                setSearch("");
                if (page) {
                  page.scrollTop = 0;
                }
              }}
            >
              {icon && <Icon name={icon} leading />}
              {title}
            </button>
          ))}
        </nav>
        <div
          class="dialog-page"
          ref={(element) => {
            page = element;
          }}
          id={id}
        >
          <For each={visible()}>
            {(category) => (
              <section class="category-section" aria-label={category.title}>
                <h3>{category.title}</h3>
                <div class="category-content">
                  {"items" in category ? (
                    <div class="category-items">
                      <For each={category.items.filter((item) => matches(item.label))}>
                        {(item) => item.render()}
                      </For>
                    </div>
                  ) : (
                    category.content()
                  )}
                </div>
              </section>
            )}
          </For>
          {visible().length === 0 && <output>No matching settings or sections.</output>}
        </div>
      </div>
    </div>
  );
};
