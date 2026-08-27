/* =============================================================
   js/game/gta08_ui.js — GTA-08 mobile HUD cleanup v1

   Presentation-only overrides. No gameplay logic is changed.
   ============================================================= */
(function (global) {
  'use strict';
  const TOWN = global.TOWN;
  if (!TOWN || !TOWN.Game) return;

  const Game = TOWN.Game;
  const UI = TOWN.GTA08 = {
    version: 'GTA-08.1',
    initialized: false,
  };

  function installStyle() {
    if (document.getElementById('gta08-style')) return;
    const s = document.createElement('style');
    s.id = 'gta08-style';
    s.textContent = [
      'body.game-play #titlecard{display:none!important}',

      'body.game-play #mission-hud{top:14px!important;left:14px!important;width:min(276px,42vw)!important}',
      'body.game-play #mission-hud .mh-card{padding:8px 10px 9px!important;background:linear-gradient(90deg,rgba(5,8,11,.62),rgba(5,8,11,.18))!important;box-shadow:none!important}',
      'body.game-play #mission-hud .mh-title{font-size:15px!important}',
      'body.game-play #mission-hud .mh-objective{font-size:12px!important;margin-top:3px!important}',
      'body.game-play #mission-hud .mh-distance{font-size:10px!important}',

      '#gta07-radar-wrap{left:16px!important;bottom:166px!important;width:146px!important;height:146px!important;border-width:1px!important;background:rgba(4,7,10,.58)!important;box-shadow:0 3px 10px rgba(0,0,0,.24)!important}',
      '#gta07-status{right:14px!important;top:112px!important;min-width:92px!important;padding:3px 2px!important;background:transparent!important;border:0!important;box-shadow:none!important}',
      '#gta07-cash{font-size:16px!important;text-shadow:0 2px 4px rgba(0,0,0,.9)!important}',
      '#gta07-weapon-label{margin-top:3px!important;font-size:9px!important;color:rgba(255,255,255,.88)!important;text-shadow:0 2px 4px rgba(0,0,0,.9)!important}',
      '#gta07-switch{right:142px!important;bottom:156px!important;width:46px!important;height:46px!important;font-size:9px!important;background:rgba(10,14,18,.48)!important;border-color:rgba(255,255,255,.30)!important}',

      'body.game-play .timechip{padding:6px 10px!important;font-size:11px!important;background:rgba(250,248,242,.76)!important;box-shadow:0 2px 8px rgba(0,0,0,.16)!important}',
      'body.game-play .topbar>.hud-btn{width:36px!important;height:36px!important;background:rgba(250,248,242,.76)!important;box-shadow:0 2px 8px rgba(0,0,0,.16)!important}',

      'body.game-play .joy-base{background:radial-gradient(circle at 50% 45%,rgba(255,255,255,.12),rgba(20,24,28,.18))!important;border-color:rgba(255,255,255,.30)!important;box-shadow:inset 0 1px 2px rgba(255,255,255,.18)!important}',
      'body.game-play .joy-knob{background:rgba(250,248,242,.78)!important;box-shadow:0 2px 7px rgba(0,0,0,.24)!important}',

      'body.game-play .actionpad .hud-btn.act{background:rgba(10,14,18,.34)!important;border-color:rgba(255,255,255,.34)!important;color:rgba(255,255,255,.94)!important;box-shadow:0 2px 8px rgba(0,0,0,.22)!important;-webkit-backdrop-filter:blur(5px)!important;backdrop-filter:blur(5px)!important}',
      'body.game-play .actionpad .hud-btn.act[data-name="interact"]{background:rgba(184,98,60,.72)!important;border-color:rgba(255,178,140,.55)!important;color:#fff!important}',

      '@media(max-width:700px){',
      '#gta07-radar-wrap{left:10px!important;bottom:150px!important;width:110px!important;height:110px!important}',
      'body.game-play #mission-hud{top:10px!important;left:10px!important;width:min(240px,45vw)!important}',
      '#gta07-status{right:8px!important;top:104px!important}',
      '#gta07-switch{right:136px!important;bottom:146px!important;width:44px!important;height:44px!important}',
      'body.game-play .actionpad .hud-btn.act{width:56px!important;height:56px!important}',
      'body.game-play .actionpad .hud-btn.act[data-name="run"]{width:48px!important;height:48px!important}',
      '}',

      '@media(max-width:900px) and (orientation:landscape) and (max-height:480px){',
      '#gta07-radar-wrap{left:10px!important;bottom:132px!important;width:104px!important;height:104px!important}',
      'body.game-play #mission-hud{top:8px!important;left:8px!important;width:min(220px,42vw)!important}',
      'body.game-play #mission-hud .mh-kicker{font-size:8px!important}',
      'body.game-play #mission-hud .mh-title{font-size:13px!important}',
      'body.game-play #mission-hud .mh-objective{font-size:10px!important}',
      '#gta07-status{top:94px!important}',
      '#gta07-switch{right:126px!important;bottom:126px!important;width:42px!important;height:42px!important}',
      'body.game-play .actionpad .hud-btn.act{width:50px!important;height:50px!important}',
      'body.game-play .actionpad .hud-btn.act[data-name="run"]{width:44px!important;height:44px!important}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  function refreshRadarSize() {
    global.requestAnimationFrame(function () {
      global.dispatchEvent(new Event('resize'));
    });
  }

  UI.init = function () {
    if (UI.initialized) return;
    UI.initialized = true;
    installStyle();
    refreshRadarSize();
    console.log('[GTA-08] compact mobile HUD ready');
  };

  const baseInit = Game.init;
  Game.init = function () {
    const out = baseInit.apply(Game, arguments);
    UI.init();
    return out;
  };
})(window);
