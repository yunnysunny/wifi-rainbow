// 视图切换与启动。

(function boot() {
  const views = {
    inspector: $('#view-inspector'),
    channels: $('#view-channels'),
    settings: $('#view-settings'),
  };

  function switchTo(view) {
    document.body.dataset.view = view;
    for (const [name, el] of Object.entries(views)) el.classList.toggle('active', name === view);
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    $('#inspector-actions').style.display = view === 'inspector' ? '' : 'none';
    $('#export-actions').style.display = view === 'settings' ? 'none' : '';

    if (view !== 'inspector') Detail.hide();
    if (view === 'channels') Channels.activate();
    else if (view === 'settings') Settings.activate();
    else Inspector.renderAll();
    log('info', `view -> ${view}`);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    I18n.init();
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchTo(t.dataset.view)));
    Inspector.init();
    Detail.init?.();
    Channels.init();
    Settings.init();
    Inspector.refreshIface();

    // 切语言：静态节点由 I18n 自己换，动态文案靠重画
    I18n.subscribe(() => {
      Inspector.refreshIface();
      Inspector.renderAll();
      Settings.render();
      if (document.body.dataset.view === 'channels') Channels.render();
      Detail.refresh();
      setStatus(t('status.ready'));
      log('info', `lang -> ${I18n.get()}`);
    });

    switchTo('inspector');
    log('info', 'boot ok');

    try {
      const selftestMode = await INVOKE('selftest');
      if (selftestMode !== null && selftestMode !== undefined && selftestMode !== false) {
        const mode = String(selftestMode);
        if (mode.startsWith('demo')) await Demo.run(mode.split(':')[1] || 'inspector');
        else await SelfTest.run(mode || 'channels');
      }
    } catch (e) {
      log('error', 'selftest failed: ' + e);
    }
  });
})();
