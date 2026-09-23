/**
 * Pixel Radar · 输入
 * ---------------------------------------------------------------
 * 鼠标 / 触摸 / 键盘。规格要求的全部交互：
 *   拖拽平移、滚轮缩放、单击选中、双击跟随、右键或长按取消跟随
 *   空格暂停、R 重置、F 全屏、S 截图、Esc 取消选中、+/- 缩放
 *
 * 两个容易做错的地方：
 *  1. **点击与拖拽的区分**：按下到抬起如果移动超过阈值就当成拖拽，
 *     否则才当成点选 —— 否则每次微小平移都会误选一架飞机。
 *  2. **缩放的锚点**：滚轮缩放必须锚定在光标处，而不是屏幕中心，
 *     否则用户会失去「我在看哪」的空间感。
 */

/** 判定为拖拽的位移阈值（CSS 像素） */
const DRAG_THRESHOLD = 4;
/** 双击判定窗口（毫秒） */
const DBL_MS = 320;
/** 触摸长按判定（毫秒）：与右键同等效力，触摸屏上没有右键可按 */
const HOLD_MS = 550;

export function bindInputs({ canvas, stage, actions, isPickerOpen }) {
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let moved = 0;
  let lastTapAt = 0;
  let lastTapHex = null;
  let holdTimer = 0;
  let longPressed = false;

  const clearHold = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
  };

  /** 客户端坐标 → 逻辑画布坐标 */
  function toLogical(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { scale } = stage.resolution;
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return; // 右键留给「取消跟随」
    dragging = true;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    downX = e.clientX;
    downY = e.clientY;
    moved = 0;
    longPressed = false;
    clearHold();
    // 触摸没有右键，长按（不动、不放）作为等价手势
    if (e.pointerType === 'touch') {
      holdTimer = setTimeout(() => {
        holdTimer = 0;
        longPressed = true;
        actions.setFollow(null);
        actions.setSelected(null);
      }, HOLD_MS);
    }
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    // 先判拖拽再换算坐标：拖拽分支根本用不到逻辑坐标，
    // 每个 move 事件都读一次 getBoundingClientRect 会强制同步布局，
    // 而此刻侧栏刚被状态栏的 500ms 定时刷新弄脏了布局。
    if (dragging && e.pointerId === pointerId) {
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > DRAG_THRESHOLD) {
        clearHold(); // 在移动就不是长按
        // 拖拽时取消跟随，否则镜头会被拉回去，手感很怪
        if (actions.getFollow()) actions.setFollow(null);
        const { scale } = stage.resolution;
        stage.panBy(dx / scale, dy / scale);
      }
      return;
    }

    const { x, y } = toLogical(e.clientX, e.clientY);
    actions.hover(x, y, e.clientX, e.clientY);
  });

  function endDrag(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    clearHold();
    canvas.style.cursor = '';
    if (longPressed) {
      // 长按已经完成「取消跟随并取消选中」，抬手时不要再当成点选
      // —— 否则会立刻又选中一架，手势等于没生效。
      longPressed = false;
      return;
    }
    if (moved <= DRAG_THRESHOLD) {
      const now = performance.now();
      const item = actions.pickAtClient(e.clientX, e.clientY);
      const hex = item ? item.hex : null;

      if (hex && lastTapHex === hex && now - lastTapAt < DBL_MS) {
        // 双击同一目标 → 锁定跟随
        actions.setFollow(hex);
        actions.setSelected(hex);
      } else {
        actions.setSelected(hex);
      }
      lastTapAt = now;
      lastTapHex = hex;
    }
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', (e) => {
    dragging = false;
    pointerId = null;
    clearHold();
    longPressed = false;
    canvas.style.cursor = '';
  });

  // 右键 / 长按 → 取消跟随并取消选中
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    actions.setFollow(null);
    actions.setSelected(null);
  });

  // 滚轮缩放，锚定光标
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    const anchor = toLogical(e.clientX, e.clientY);
    actions.zoomBy(dir, anchor);
  }, { passive: false });

  // 触摸板双指缩放（部分浏览器给的是 ctrl+wheel，已由上面覆盖；这里兜底 gesture 事件）
  canvas.addEventListener('dblclick', (e) => e.preventDefault());

  /* ── 键盘 ── */
  window.addEventListener('keydown', (e) => {
    // 输入框内不劫持键盘
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        actions.togglePause();
        break;
      case 'r':
      case 'R':
        actions.resetView();
        break;
      case 'f':
      case 'F':
        actions.toggleFullscreen();
        break;
      case 's':
      case 'S':
        actions.screenshot();
        break;
      case 'Escape':
        if (isPickerOpen()) return; // 选择器自己有 Esc 处理
        actions.setFollow(null);
        actions.setSelected(null);
        break;
      case '+':
      case '=':
        e.preventDefault();
        actions.zoomBy(1);
        break;
      case '-':
      case '_':
        e.preventDefault();
        actions.zoomBy(-1);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const step = e.shiftKey ? 40 : 12;
        const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        actions.setFollow(null);
        stage.panBy(dx, dy);
        break;
      }
      default:
        break;
    }
  });

  return {
    isDragging: () => dragging,
  };
}
