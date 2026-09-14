// dsh-im-multiagent host plugin entry (stage 1 skeleton).
//
// The full implementation (SessionMirror, InboundRouter, BotChannel,
// InteractionAdapter, MenuBuilder, CmdSkillPicker, StateStore, Management
// RPC) lands in later stages of .dsh/plans/dsh-im-multiagent-architecture.md.
// The cordis row is disabled by default, so this stub is not mounted in the
// live profile.

export const name = 'dsh-im-multiagent';
export const inject = ['connection', 'credentials', 'agents', 'typersGateway'];

export async function apply(ctx, config = {}) {
  ctx.logger?.warn?.(
    '[dsh-im-multiagent] skeleton plugin: implementation not yet mounted',
  );
  void config;
}