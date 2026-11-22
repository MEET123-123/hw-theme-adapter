/**
 * Native Browser Web Components & Styles for Huawei Adapted Frontend UI:
 * 1) <hw-drawer>: Click/swipe-triggered slide drawer & modal container
 * 2) <hw-image-switcher>: Container-embedded multi-variant image switcher
 */

export const HW_COMPONENTS_CSS = `
/* === HwFlex Frontend Web Components (<hw-drawer>, <hw-image-switcher>) === */
hw-drawer {
  position: absolute;
  inset: 0;
  z-index: 420;
  pointer-events: none;
  overflow: hidden;
  display: block;
}
hw-drawer .hw-drawer-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(2, 6, 23, 0.42);
  opacity: 0;
  transition: opacity 240ms ease;
  pointer-events: none;
}
hw-drawer[open] .hw-drawer-backdrop {
  opacity: 1;
}
hw-drawer[open][backdrop="true"] .hw-drawer-backdrop {
  pointer-events: auto;
}
hw-drawer .hw-drawer-surface {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  will-change: transform, opacity;
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease;
}
hw-drawer[direction="right"] .hw-drawer-surface {
  transform: translate3d(104%, 0, 0);
}
hw-drawer[direction="left"] .hw-drawer-surface {
  transform: translate3d(-104%, 0, 0);
}
hw-drawer[direction="bottom"] .hw-drawer-surface {
  transform: translate3d(0, 104%, 0);
}
hw-drawer[direction="top"] .hw-drawer-surface {
  transform: translate3d(0, -104%, 0);
}
hw-drawer[direction="center"] .hw-drawer-surface {
  transform: scale(0.92);
}
hw-drawer[open] .hw-drawer-surface {
  transform: translate3d(0, 0, 0) scale(1);
  opacity: 1;
}
hw-drawer .hw-drawer-handle {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 20;
  background: rgba(15, 23, 42, 0.78);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.55);
  border-radius: 999px;
  font-size: 10px;
  padding: 2px 7px;
  cursor: pointer;
  pointer-events: auto;
  display: none;
}
hw-drawer[open][show-handle="true"] .hw-drawer-handle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

hw-image-switcher {
  position: absolute;
  display: block;
  overflow: hidden;
  pointer-events: none;
}
hw-image-switcher[data-comp-frame="true"] {
  outline: 1.5px dashed rgba(250, 204, 21, 0.85);
  box-shadow: inset 0 0 0 1px rgba(250, 204, 21, 0.3);
}
hw-image-switcher .hw-slot {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  will-change: opacity, transform;
  transition: opacity 260ms ease, transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
}
hw-image-switcher[transition="scale"] .hw-slot {
  transform: scale(0.95);
}
hw-image-switcher[transition="slide"] .hw-slot {
  transform: translate3d(8%, 0, 0);
}
hw-image-switcher .hw-slot[data-active="true"] {
  opacity: 1;
  transform: translate3d(0, 0, 0) scale(1);
}
hw-image-switcher .hw-slot img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: fill;
}
hw-image-switcher .hw-switcher-dots {
  position: absolute;
  left: 50%;
  bottom: 4px;
  transform: translateX(-50%);
  display: none;
  gap: 4px;
  background: rgba(15, 23, 42, 0.65);
  padding: 2px 5px;
  border-radius: 999px;
  z-index: 15;
  pointer-events: auto;
}
hw-image-switcher[show-dots="true"] .hw-switcher-dots {
  display: flex;
}
hw-image-switcher .hw-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(226, 232, 240, 0.45);
  border: none;
  padding: 0;
  cursor: pointer;
}
hw-image-switcher .hw-dot.active {
  background: #38bdf8;
  transform: scale(1.25);
}
`;

export const HW_COMPONENTS_JS = `
(function () {
  if (typeof window === 'undefined' || !window.customElements) return;

  class HwDrawerElement extends HTMLElement {
    static get observedAttributes() {
      return ['open', 'direction', 'label', 'backdrop', 'show-handle'];
    }

    connectedCallback() {
      this._ensureStructure();
      this._sync();
    }

    attributeChangedCallback() {
      if (this.isConnected) this._sync();
    }

    _ensureStructure() {
      if (this._initialized) return;
      this._initialized = true;
      const existingNodes = Array.from(this.childNodes);

      const backdrop = document.createElement('div');
      backdrop.className = 'hw-drawer-backdrop';
      backdrop.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('hw-drawer-dismiss', {
          bubbles: true,
          detail: {
            drawerId: this.getAttribute('drawer-id') || this.id,
            stateVar: this.getAttribute('state-var') || '',
          },
        }));
      });

      const surface = document.createElement('div');
      surface.className = 'hw-drawer-surface';
      for (const n of existingNodes) {
        if (n.nodeType === 1 && (n.classList.contains('hw-drawer-backdrop') || n.classList.contains('hw-drawer-surface'))) {
          continue;
        }
        surface.appendChild(n);
      }

      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'hw-drawer-handle';
      handle.textContent = '× 收起滑窗';
      handle.addEventListener('pointerdown', (e) => e.stopPropagation());
      handle.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        this.dispatchEvent(new CustomEvent('hw-drawer-dismiss', {
          bubbles: true,
          detail: {
            drawerId: this.getAttribute('drawer-id') || this.id,
            stateVar: this.getAttribute('state-var') || '',
          },
        }));
      });
      surface.appendChild(handle);

      this.appendChild(backdrop);
      this.appendChild(surface);
      this._surface = surface;
      this._handle = handle;
    }

    get surface() {
      this._ensureStructure();
      return this._surface;
    }

    _sync() {
      const isOpen = this.hasAttribute('open');
      this.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
      if (this._handle) {
        const lbl = this.getAttribute('label') || '';
        this._handle.title = lbl ? '收起: ' + lbl : '收起滑窗';
      }
    }
  }

  class HwImageSwitcherElement extends HTMLElement {
    static get observedAttributes() {
      return ['active-value', 'show-dots', 'transition'];
    }

    connectedCallback() {
      this._syncSlots();
    }

    attributeChangedCallback() {
      if (this.isConnected) this._syncSlots();
    }

    refreshSlots() {
      this._syncSlots();
    }

    _syncSlots() {
      const slots = Array.from(this.querySelectorAll(':scope > figure.hw-slot'));
      if (slots.length === 0) return;

      let activeVal = this.getAttribute('active-value');
      const hasMatch = activeVal !== null && slots.some(s => String(s.getAttribute('data-val')) === String(activeVal));
      if (!hasMatch) {
        activeVal = slots[0].getAttribute('data-val');
      }

      for (const s of slots) {
        const matched = String(s.getAttribute('data-val')) === String(activeVal);
        s.setAttribute('data-active', matched ? 'true' : 'false');
      }

      if (this.getAttribute('show-dots') === 'true') {
        let dots = this.querySelector(':scope > .hw-switcher-dots');
        if (!dots) {
          dots = document.createElement('div');
          dots.className = 'hw-switcher-dots';
          this.appendChild(dots);
        }
        dots.innerHTML = '';
        for (const s of slots) {
          const val = s.getAttribute('data-val');
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'hw-dot' + (String(val) === String(activeVal) ? ' active' : '');
          b.title = (this.getAttribute('state-var') || 'slot') + '=' + val;
          b.addEventListener('pointerdown', (e) => e.stopPropagation());
          b.addEventListener('pointerup', (e) => {
            e.stopPropagation();
            this.dispatchEvent(new CustomEvent('hw-image-switch', {
              bubbles: true,
              detail: {
                switcherId: this.getAttribute('switcher-id') || this.id,
                stateVar: this.getAttribute('state-var') || '',
                value: Number.isFinite(Number(val)) && val !== '' ? Number(val) : val,
              },
            }));
          });
          dots.appendChild(b);
        }
      }
    }
  }

  if (!window.customElements.get('hw-drawer')) {
    window.customElements.define('hw-drawer', HwDrawerElement);
  }
  if (!window.customElements.get('hw-image-switcher')) {
    window.customElements.define('hw-image-switcher', HwImageSwitcherElement);
  }
})();
`;
