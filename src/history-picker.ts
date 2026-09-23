import { TreeSelectorComponent, UserMessageSelectorComponent, type ExtensionContext } from '@earendil-works/pi-coding-agent';

/** Native Pi selectors, but callbacks return IDs; they never navigate the source. */
export async function pickHistory(ctx: ExtensionContext, kind: 'tree' | 'fork'): Promise<string | undefined> {
  if (ctx.mode !== 'tui') throw new Error('History pickers require interactive terminal Pi');
  if (kind === 'tree') {
    const tree = ctx.sessionManager.getTree();
    if (!tree.length) throw new Error('No history to select');
    return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => new TreeSelectorComponent(
      tree, ctx.sessionManager.getLeafId(), tui.terminal.rows,
      id => done(id), () => done(undefined), undefined,
    ));
  }
  const users = ctx.sessionManager.getEntries().filter(e => e.type === 'message' && e.message.role === 'user').map((e: any) => ({
    id: e.id, timestamp: e.timestamp,
    text: typeof e.message.content === 'string' ? e.message.content : e.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n') || '[Attachment-only user message]',
  }));
  if (!users.length) throw new Error('No user messages to fork from');
  return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
    const selector = new UserMessageSelectorComponent(users, id => done(id), () => done(undefined), users.at(-1)?.id);
    return {
      render: width => selector.render(width), invalidate: () => selector.invalidate(),
      handleInput: data => { selector.getMessageList().handleInput(data); tui.requestRender(); },
    };
  });
}
