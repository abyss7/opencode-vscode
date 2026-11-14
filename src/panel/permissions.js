'use strict';

/**
 * @file Permission approvals, saved project permission rules, Smart-review
 * polling, and interactive form elicitations for `SessionPanel`.
 *
 * State fields owned on `SessionPanel`:
 * - `_permissions`, `_elicitations`
 * - `_permissionState`, `_permissionUpdating`
 * - `_smartReviewsRefreshing`, `_smartReviewErrorLogged`
 */

const panelPermissions = {
  async _onPermission(request) {
    if (this._disposed) {
      request.respond(null);
      return;
    }

    const config = this.deps.getConfig();
    if (!this.deps.permissions && config.autoApprovePermissions === 'allowAll') {
      const option =
        request.options.find((item) => String(item.kind || '').startsWith('allow')) ||
        request.options.find((item) => /allow|approve/i.test(String(item.name || '')));
      request.respond(option ? option.optionId : null);
      const title = (request.toolCall && request.toolCall.title) || 'action';
      this._post({
        type: 'info',
        text: option
          ? `Automatically allowed: ${title}`
          : `Permission request denied: ${title}`,
      });
      return;
    }

    this._permissions.set(request.requestId, request);
    this._refreshAttention();
    if (this.deps.permissions) {
      try {
        request.policy = await this.deps.permissions.describe(
          request.sessionId || this.sessionId,
          this.cwd,
          request.toolCall?.toolCallId
        );
      } catch (error) {
        request.policy = { reason: `Rule details unavailable: ${error.message}`, choices: [] };
      }
    }
    if (this._disposed || !this._permissions.has(request.requestId)) return;
    this._post({
      type: 'permission',
      requestId: request.requestId,
      toolCall: request.toolCall,
      policy: request.policy,
      // Project-wide Always would escape the session/profile boundary.
      options: this.deps.permissions
        ? request.options.filter((option) => !String(option.kind).endsWith('_always'))
        : request.options,
    });
  },

  _answerPermission(requestId, optionId) {
    const request = this._permissions.get(requestId);
    if (!request || request.saving) return;
    if (optionId !== null && !request.options.some((option) => option.optionId === optionId)) return;
    if (
      this.deps.permissions &&
      request.options.some((option) => option.optionId === optionId && String(option.kind).endsWith('_always'))
    ) {
      return;
    }
    this._permissions.delete(requestId);
    this._refreshAttention();
    request.respond(optionId);
  },

  async _rememberPermission(message) {
    const request = this._permissions.get(message.requestId);
    if (!request || request.saving || !this.deps.permissions) return;
    request.saving = true;
    try {
      if (!request.policy?.revision || !['allow', 'deny'].includes(message.effect)) {
        throw new Error('Rule details unavailable');
      }
      const kind = message.effect === 'allow' ? 'allow_once' : 'reject_once';
      const option = request.options.find((item) => item.kind === kind);
      if (!option) throw new Error('This request does not support that decision');
      // Refresh settings too; the plugin rejects an outdated description rather than
      // authorizing a request under a different profile or newly edited project rules.
      await this._refreshPermissionProfile();
      await this.deps.permissions.remember(
        request.sessionId || this.sessionId,
        this.cwd,
        request.toolCall?.toolCallId,
        request.policy,
        message.choiceId,
        message.effect
      );
      if (this._disposed || !this._permissions.has(message.requestId)) return;
      request.saving = false;
      this._answerPermission(message.requestId, option.optionId);
      this._post({
        type: 'permissionRuleResult',
        requestId: message.requestId,
        note: `${message.effect === 'allow' ? 'Allow' : 'Forbid'} saved for this project · ${request.policy.profileLabel}`,
      });
    } catch (error) {
      try {
        request.policy = await this.deps.permissions.describe(
          request.sessionId || this.sessionId,
          this.cwd,
          request.toolCall?.toolCallId
        );
      } catch {
        request.policy = { reason: 'This request is no longer available for saving.', choices: [] };
      }
      if (!this._disposed && this._permissions.has(message.requestId)) {
        this._post({
          type: 'permissionRuleResult',
          requestId: message.requestId,
          error: error.message,
          policy: request.policy,
        });
      }
    } finally {
      request.saving = false;
    }
  },

  async _openPermissionRules() {
    if (!this.deps.permissions) return;
    try {
      await this.deps.permissions.openRules(this.cwd);
    } catch (error) {
      this._post({ type: 'error', message: error.message });
    }
  },

  _onElicitation(request) {
    if (this._disposed || this._archived) {
      request.respond('decline');
      return;
    }
    this._elicitations.set(request.requestId, request);
    this._refreshAttention();
    this._post({
      type: 'elicitation',
      requestId: request.requestId,
      toolCallId: request.toolCallId || null,
      message: request.message,
      requestedSchema: request.requestedSchema,
    });
  },

  _answerElicitation(requestId, action, content) {
    const request = this._elicitations.get(requestId);
    if (!request) return;
    this._elicitations.delete(requestId);
    this._refreshAttention();
    request.respond(action, content);
  },

  async _refreshPermissionProfile(change = {}) {
    const mode = (this._client.configOptions || []).find(
      (item) => item.id === 'mode' || item.id === 'agent' || item.category === 'mode'
    );
    const state = await this.deps.permissions.configure(
      this.sessionId,
      this.cwd,
      mode?.currentValue || 'build',
      change
    );
    this._permissionState = state;
    this._post({ type: 'permissionProfile', ...state });
  },

  async _permissionsBeforePrompt() {
    if (this._permissionUpdating) {
      this._post({
        type: 'error',
        message: 'Permissions are being updated. Please send again when the selectors are ready.',
      });
      this._post({ type: 'turnEnd', stopReason: 'error' });
      return false;
    }
    if (this._busy) return Boolean(this._permissionState);
    this._permissionUpdating = true;
    try {
      await this._refreshPermissionProfile();
      return true;
    } catch (error) {
      this._post({ type: 'error', message: `Permissions not applied: ${error.message}` });
      this._post({ type: 'turnEnd', stopReason: 'error' });
      return false;
    } finally {
      this._permissionUpdating = false;
    }
  },

  async _changePermissions(message) {
    if (!this.deps.permissions || !this.sessionId || this._permissionUpdating) return;
    this._permissionUpdating = true;
    try {
      if (this._busy || this._permissions.size) throw new Error('Change permissions between turns.');
      const change = {};
      if (typeof message.profile === 'string') change.selected = message.profile;
      if (typeof message.newActions === 'string') change.newActions = message.newActions;
      await this._refreshPermissionProfile(change);
    } catch (error) {
      this._post({ type: 'error', message: error.message });
      if (this._permissionState) this._post({ type: 'permissionProfile', ...this._permissionState });
    } finally {
      this._permissionUpdating = false;
    }
  },

  async _refreshSmartReviews() {
    if (
      this._disposed ||
      !this.sessionId ||
      !this.deps.permissions ||
      !this._permissionState ||
      this._smartReviewsRefreshing
    ) {
      return;
    }
    this._smartReviewsRefreshing = true;
    try {
      const result = await this.deps.api.permissionProfiles(
        'reviews',
        { sessionID: this.sessionId },
        this.cwd
      );
      if (!this._disposed) this._post({ type: 'smartReviews', reviews: result.reviews || [] });
      this._smartReviewErrorLogged = false;
    } catch (error) {
      if (!this._smartReviewErrorLogged) {
        this.deps.log(`Smart review status unavailable: ${error.message}`);
      }
      this._smartReviewErrorLogged = true;
    } finally {
      this._smartReviewsRefreshing = false;
    }
  },
};

module.exports = { panelPermissions };
