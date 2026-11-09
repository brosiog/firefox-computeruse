// Element refs. A ref is a small integer, stable for an element for the life of the document, so the model sees the
// same number for the same control across steps. Refs fail closed: an id the agent was never shown, or whose element
// left the document, is an error, never a guess.

export class Refs {
  private next = 1;
  private ids = new WeakMap<Element, number>();
  private els = new Map<number, WeakRef<Element>>();
  private shown = new Set<number>();
  private links = new Set<string>();

  /** Id for an element, assigning one if needed, and marks it as shown to the agent. */
  show(el: Element): number {
    let id = this.ids.get(el);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(el, id);
      this.els.set(id, new WeakRef(el));
    }
    this.shown.add(id);
    // Where shown links point: the agent may navigate to those (a page offered them), not to URLs it made up.
    const a = el.closest?.('a[href]') as HTMLAnchorElement | null;
    if (a && /^https?:/.test(a.href)) this.links.add(a.href.split('#')[0]);
    return id;
  }

  hrefs(): string[] {
    return [...this.links];
  }

  peek(el: Element): number | undefined {
    return this.ids.get(el);
  }

  resolve(id: number): { el: Element } | { error: string } {
    if (!this.shown.has(id)) return { error: `ref ${id} does not exist on this page. Use a ref from the current page state.` };
    const el = this.els.get(id)?.deref();
    if (!el || !el.isConnected) {
      this.shown.delete(id);
      return { error: `ref ${id} is gone: that element was removed from the page. Use the current page state.` };
    }
    return { el };
  }
}
