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
    // 先加载设置：Inspector.init 里的自动刷新定时器要读 scanSec，顶栏的「按 SSID 分组」复选框要同步 groupBy
    Settings.init();
    Inspector.init();
    Detail.init?.();
    Channels.init();
    Inspector.refreshIface();

    // 主题实际明暗变了（设置里切，或跟随系统时系统自己切了）：画布颜色是 JS 里读的，得重画
    Theme.subscribe(() => {
      Inspector.renderAll();
      if (document.body.dataset.view === 'channels') Channels.render();
      Detail.refresh();
      log('info', `theme -> ${Theme.get()} (${Theme.resolved()})`);
    });

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
