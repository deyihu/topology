import { Store, Observer } from 'le5le-store';

import { Options, KeyType, KeydownType, DefalutOptions } from './options';
import { Pen, PenType } from './models/pen';
import { Node } from './models/node';
import { Point } from './models/point';
import { Line } from './models/line';
import { TopologyData } from './models/data';
import { Lock, AnchorMode } from './models/status';
import { drawNodeFns, drawLineFns } from './middles/index';
import { Offscreen } from './offscreen';
import { RenderLayer } from './renderLayer';
import { HoverLayer } from './hoverLayer';
import { ActiveLayer } from './activeLayer';
import { AnimateLayer } from './animateLayer';
import { DivLayer } from './divLayer';
import { Rect } from './models/rect';
import { s8 } from './utils/uuid';
import { pointInRect } from './utils/canvas';
import { getRect } from './utils/rect';
import { Socket } from './socket';
import { MQTT } from './mqtt';

const resizeCursors = ['nw-resize', 'ne-resize', 'se-resize', 'sw-resize'];
enum MoveInType {
  None,
  Line,
  LineMove,
  LineFrom,
  LineTo,
  LineControlPoint,
  Nodes,
  ResizeCP,
  HoverAnchors,
  Rotate,
}

interface ICaches {
  index: number;
  list: TopologyData[];
}

const dockOffset = 10;

export class Topology {
  id: String;
  data: TopologyData = new TopologyData();
  clipboard: TopologyData;
  caches: ICaches = {
    index: 0,
    list: [],
  };
  options: Options;

  parentElem: HTMLElement;
  canvas: RenderLayer;
  offscreen: Offscreen;
  hoverLayer: HoverLayer;
  activeLayer: ActiveLayer;
  animateLayer: AnimateLayer;
  divLayer: DivLayer;

  private subcribe: Observer;
  private subcribeRender: Observer;
  private subcribeImage: Observer;
  private imageTimer: any;
  private subcribeAnimateEnd: Observer;
  private subcribeAnimateMoved: Observer;
  private subcribeMediaEnd: Observer;

  touchedNode: any;
  lastHoverNode: Node;
  lastHoverLine: Line;
  input = document.createElement('textarea');
  inputObj: Pen;
  mouseDown: { x: number; y: number; restore?: boolean };
  lastTranlated = { x: 0, y: 0 };
  moveIn: {
    type: MoveInType;
    activeAnchorIndex: number;
    hoverAnchorIndex: number;
    hoverNode: Node;
    hoverLine: Line;
    activeNode: Node;
    lineControlPoint: Point;
  } = {
      type: MoveInType.None,
      activeAnchorIndex: 0,
      hoverAnchorIndex: 0,
      hoverNode: null,
      hoverLine: null,
      activeNode: null,
      lineControlPoint: null,
    };
  needCache = false;

  private tip = '';
  private raf: number;
  tipMarkdown: HTMLElement;
  tipElem: HTMLElement;
  gridElem: HTMLElement = document.createElement('div');

  socket: Socket;
  mqtt: MQTT;

  private scheduledAnimationFrame = false;
  private scrolling = false;
  private rendering = false;
  constructor(parent: string | HTMLElement, options?: Options) {
    this.id = s8();
    Store.set(this.generateStoreKey('topology-data'), this.data);

    if (!options) {
      options = {};
    }
    const font = Object.assign({}, DefalutOptions.font, options.font);
    options.font = font;
    this.options = Object.assign({}, DefalutOptions, options);

    if (typeof parent === 'string') {
      this.parentElem = document.getElementById(parent);
    } else {
      this.parentElem = parent;
    }
    this.parentElem.style.position = 'relative';
    this.parentElem.style.overflow = 'auto';
    this.createGrid();

    const id = this.id;
    this.activeLayer = new ActiveLayer(this.options, id);
    this.hoverLayer = new HoverLayer(this.options, id);
    this.animateLayer = new AnimateLayer(this.options, id);
    this.offscreen = new Offscreen(this.parentElem, this.options, id);
    this.canvas = new RenderLayer(this.parentElem, this.options, id);
    this.divLayer = new DivLayer(this.parentElem, this.options, id);

    this.resize();

    this.divLayer.canvas.ondragover = (event) => event.preventDefault();
    this.divLayer.canvas.ondrop = (event) => {
      try {
        const json = event.dataTransfer.getData('Topology') || event.dataTransfer.getData('Text');
        if (!json) return;
        const obj = JSON.parse(json);
        event.preventDefault();
        this.dropNodes(Array.isArray(obj) ? obj : [obj], event.offsetX, event.offsetY);
      } catch { }
    };
    this.subcribe = Store.subscribe(this.generateStoreKey('LT:render'), () => {
      this.render();
    });
    this.subcribeRender = Store.subscribe('LT:render', () => {
      this.render();
    });
    this.subcribeImage = Store.subscribe(this.generateStoreKey('LT:imageLoaded'), () => {
      if (this.imageTimer) {
        clearTimeout(this.imageTimer);
      }
      this.imageTimer = setTimeout(() => {
        this.render();
      }, 100);
    });
    this.subcribeAnimateMoved = Store.subscribe(this.generateStoreKey('LT:rectChanged'), (e: any) => {
      this.activeLayer.updateLines(this.data.pens);
    });
    this.subcribeMediaEnd = Store.subscribe(this.generateStoreKey('mediaEnd'), (node: Node) => {
      if (node.nextPlay) {
        this.animateLayer.readyPlay(node.nextPlay);
        this.animateLayer.animate();
      }
      this.dispatch('mediaEnd', node);
    });
    this.subcribeAnimateEnd = Store.subscribe(this.generateStoreKey('animateEnd'), (e: any) => {
      if (!e) {
        return;
      }
      switch (e.type) {
        case 'node':
          this.offscreen.render();
          break;
      }
      this.divLayer.playNext(e.data.nextAnimate);
      this.dispatch('animateEnd', e);
    });

    this.divLayer.canvas.onmousemove = this.onMouseMove;
    this.divLayer.canvas.onmousedown = this.onmousedown;
    this.divLayer.canvas.onmouseup = this.onmouseup;
    this.divLayer.canvas.ondblclick = this.ondblclick;
    this.divLayer.canvas.tabIndex = 0;
    this.divLayer.canvas.onblur = () => {
      this.mouseDown = null;
    };
    this.divLayer.canvas.onwheel = (event) => {
      if (this.options.disableScale) {
        return;
      }
      switch (this.options.scaleKey) {
        case KeyType.None:
          break;
        case KeyType.Ctrl:
          if (!event.ctrlKey) {
            return;
          }
          break;
        case KeyType.Shift:
          if (!event.shiftKey) {
            return;
          }
          break;
        case KeyType.Alt:
          if (!event.altKey) {
            return;
          }
          break;
        default:
          if (!event.ctrlKey && !event.altKey) {
            return;
          }
      }
      event.preventDefault();

      if (event.deltaY < 0) {
        this.scale(1.1);
      } else {
        this.scale(0.9);
      }

      this.divLayer.canvas.focus();

      return false;
    };

    this.divLayer.canvas.ontouchend = (event) => {
      this.ontouched(event);
    };

    switch (this.options.keydown) {
      case KeydownType.Document:
        document.onkeydown = this.onkeydown;
        break;
      case KeydownType.Canvas:
        this.divLayer.canvas.onkeydown = this.onkeydown;
        break;
    }

    this.input.style.position = 'absolute';
    this.input.style.zIndex = '-1';
    this.input.style.left = '-1000px';
    this.input.style.width = '0';
    this.input.style.height = '0';
    this.input.style.outline = 'none';
    this.input.style.border = '1px solid #cdcdcd';
    this.input.style.resize = 'none';
    this.parentElem.appendChild(this.input);

    this.createMarkdownTip();

    this.cache();

    this.parentElem.onresize = this.winResize;
    window.addEventListener('resize', this.winResize);
    (window as any).topology = this;
  }

  winResize = () => {
    let timer: any;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      this.resize();
      this.overflow();
    }, 100);
  };

  resize(size?: { width: number; height: number }) {
    this.canvas.resize(size);
    this.offscreen.resize(size);
    this.divLayer.resize(size);

    this.render();
    this.showGrid();
    this.dispatch('resize', size);
  }

  dropNodes(jsonList: any[], offsetX: number, offsetY: number) {
    let x: number, y: number;
    if (jsonList.length) {
      const rect = jsonList[0].rect;
      x = rect.x;
      y = rect.y;
    }
    let firstNode;
    jsonList.forEach((json) => {
      if (!firstNode) {
        json.rect.x = (offsetX - json.rect.width / 2) << 0;
        json.rect.y = (offsetY - json.rect.height / 2) << 0;
        firstNode = json;
      } else {
        //Layout relative to the first node
        const rect = json.rect;
        const dx = rect.x - x,
          dy = rect.y - y;
        json.rect.x = firstNode.rect.x + dx;
        json.rect.y = firstNode.rect.y + dy;
      }

      if (json.name === 'lineAlone') {
        this.addLine(
          {
            name: this.data.lineName,
            from: new Point(json.rect.x, json.rect.y),
            fromArrow: this.data.fromArrowType,
            to: new Point(json.rect.x + json.rect.width, json.rect.y + json.rect.height),
            toArrow: this.data.toArrowType,
            strokeStyle: this.options.color,
          },
          true
        );
      } else {
        const node = new Node(json);
        node.setTID(this.id);
        node.clearChildrenIds();
        this.addNode(node, true);
        if (node.name === 'div') {
          this.dispatch('LT:addDiv', node);
        }
      }
    });

    this.divLayer.canvas.focus();
  }

  getTouchOffset(touch: Touch) {
    let currentTarget: any = this.parentElem;
    let x = 0;
    let y = 0;
    while (currentTarget) {
      x += currentTarget.offsetLeft;
      y += currentTarget.offsetTop;
      currentTarget = currentTarget.offsetParent;
    }
    return { offsetX: touch.pageX - x, offsetY: touch.pageY - y };
  }

  private ontouched(event: TouchEvent) {
    if (!this.touchedNode) {
      return;
    }

    const pos = this.getTouchOffset(event.changedTouches[0]);
    this.touchedNode.rect.x = pos.offsetX - this.touchedNode.rect.width / 2;
    this.touchedNode.rect.y = pos.offsetY - this.touchedNode.rect.height / 2;

    const node = new Node(this.touchedNode);
    node.setTID(this.id);
    node.clearChildrenIds();
    this.addNode(node, true);
    this.touchedNode = undefined;
  }

  addNode(node: Node | any, focus = false) {
    if (this.data.locked || !drawNodeFns[node.name]) {
      return null;
    }

    // if it's not a Node
    if (!node.init) {
      node = new Node(node);
    }

    if (!node.strokeStyle && this.options.color) {
      node.strokeStyle = this.options.color;
    }

    for (const key in node.font) {
      if (!node.font[key]) {
        node.font[key] = this.options.font[key];
      }
    }

    if (this.data.scale !== 1) {
      node.scale(this.data.scale);
    }

    this.data.pens.push(node);

    if (focus) {
      this.activeLayer.setPens([node]);
      this.render();
      this.animate(true);
      this.cache();
      this.dispatch('addNode', node);
    }

    return node;
  }

  addLine(line: any, focus = false) {
    if (this.data.locked) {
      return null;
    }

    if (!line.clone) {
      line = new Line(line);
      line.calcControlPoints(true);
    }
    this.data.pens.push(line);

    if (focus) {
      this.activeLayer.setPens([line]);
      this.render();
      this.animate(true);
      this.cache();
      this.dispatch('addLine', line);
    }

    return line;
  }

  // Render or redraw
  render(noFocus = false) {
    if (noFocus) {
      this.activeLayer.pens = [];
      this.hoverLayer.node = null;
      this.hoverLayer.line = null;
    }
    if (this.rendering) {
      return this;
    }
    this.rendering = true;
    this.offscreen.render();
    this.canvas.render();
    this.rendering = false;
  }

  // open - redraw by the data
  open(data?: any) {
    if (!data) {
      data = { pens: [] };
    }
    if (typeof data === 'string') {
      data = JSON.parse(data);
    }

    this.animateLayer.stop();
    this.lock(data.locked || Lock.None);

    if (data.lineName) {
      this.data.lineName = data.lineName;
    }
    this.data.fromArrowType = data.fromArrowType;
    this.data.toArrowType = data.toArrowType;

    this.data.scale = data.scale || 1;
    Store.set(this.generateStoreKey('LT:scale'), this.data.scale);
    this.dispatch('scale', this.data.scale);

    this.data.bkColor = data.bkColor;
    this.data.bkImage = data.bkImage;
    this.data.pens = [];

    // for old data.
    if (data.nodes) {
      for (const item of data.nodes) {
        this.data.pens.push(new Node(item));
      }
      for (const item of data.lines) {
        this.data.pens.push(new Line(item));
      }
    }
    // end.

    if (data.pens) {
      for (const item of data.pens) {
        if (!item.from) {
          this.data.pens.push(new Node(item));
        } else {
          this.data.pens.push(new Line(item));
        }
      }
    }

    this.data.websocket = data.websocket;
    this.data.mqttUrl = data.mqttUrl;
    this.data.mqttOptions = data.mqttOptions || { clientId: s8() };
    this.data.mqttTopics = data.mqttTopics;
    this.data.grid = data.grid;
    if (typeof data.data === 'object') {
      this.data.data = JSON.parse(JSON.stringify(data.data));
    } else {
      this.data.data = data.data || '';
    }

    this.caches.list = [];
    this.cache();

    this.divLayer.clear();

    this.overflow();
    this.render(true);

    this.parentElem.scrollLeft = 0;
    this.parentElem.scrollTop = 0;

    this.animate(true);
    this.openSocket();
    this.openMqtt();

    this.showGrid();
  }

  openSocket(url?: string) {
    this.closeSocket();
    if (url || this.data.websocket) {
      this.socket = new Socket(url || this.data.websocket, this.data);
    }
  }

  closeSocket() {
    if (this.socket) {
      this.socket.close();
    }
  }

  openMqtt(url?: string, options?: any) {
    this.closeMqtt();
    if (url || this.data.mqttUrl) {
      this.mqtt = new MQTT(url || this.data.mqttUrl, options || this.data.mqttOptions, this.data.mqttTopics, this.data);
    }
  }

  closeMqtt() {
    if (this.mqtt) {
      this.mqtt.close();
    }
  }

  overflow() {
    const rect = this.getRect();
    let { width, height } = this.canvas;
    const maxWidth = Math.max(rect.width, rect.ex);
    const maxHeight = Math.max(rect.height, rect.ey);
    const offset = 50;
    if (width < maxWidth) {
      width = maxWidth + offset;
    }
    if (height < maxHeight) {
      height = maxHeight + offset;
    }
    this.resize({ width, height });
    return rect;
  }

  private setNodeText() {
    this.inputObj.text = this.input.value;
    this.input.style.zIndex = '-1';
    this.input.style.left = '-1000px';
    this.input.style.width = '0';
    this.cache();
    this.offscreen.render();

    this.dispatch('setText', this.inputObj);

    this.inputObj = null;
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.scheduledAnimationFrame || this.data.locked === Lock.NoEvent) {
      return;
    }

    // https://caniuse.com/#feat=mdn-api_mouseevent_buttons
    if (this.mouseDown && !this.mouseDown.restore && e.buttons !== 1) {
      // 防止异常情况导致mouseup事件没有触发
      this.onmouseup(e);
      return;
    }

    if (this.mouseDown && this.moveIn.type === MoveInType.None) {
      let b = false;
      switch (this.options.translateKey) {
        case KeyType.None:
          b = true;
          break;
        case KeyType.Ctrl:
          if (e.ctrlKey) {
            b = true;
          }
          break;
        case KeyType.Shift:
          if (e.shiftKey) {
            b = true;
          }
          break;
        case KeyType.Alt:
          if (e.altKey) {
            b = true;
          }
          break;
        default:
          if (e.ctrlKey || e.altKey) {
            b = true;
          }
      }
      if (b) {
        const canvasPos = this.divLayer.canvas.getBoundingClientRect() as DOMRect;
        this.translate(e.x - this.mouseDown.x - canvasPos.x, e.y - this.mouseDown.y - canvasPos.y, true);
        return false;
      }
    }

    if (this.data.locked && this.mouseDown && this.moveIn.type !== MoveInType.None) {
      return;
    }

    this.scheduledAnimationFrame = true;
    const canvasPos = this.divLayer.canvas.getBoundingClientRect() as DOMRect;
    const pos = new Point(e.x - canvasPos.x, e.y - canvasPos.y);

    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.raf = null;

      if (!this.mouseDown) {
        this.getMoveIn(pos);

        // Render hover anchors.
        if (this.moveIn.hoverNode !== this.lastHoverNode) {
          if (this.lastHoverNode) {
            // Send a move event.
            this.dispatch('moveOutNode', this.lastHoverNode);

            this.hideTip();

            // Clear hover anchors.
            this.hoverLayer.node = null;
          }

          if (this.moveIn.hoverNode) {
            this.hoverLayer.node = this.moveIn.hoverNode;

            // Send a move event.
            this.dispatch('moveInNode', this.moveIn.hoverNode);

            this.showTip(this.moveIn.hoverNode, pos);
          }
        }

        if (this.moveIn.hoverLine !== this.lastHoverLine) {
          if (this.lastHoverLine) {
            this.dispatch('moveOutLine', this.lastHoverLine);

            this.hideTip();
          }

          if (this.moveIn.hoverLine) {
            this.dispatch('moveInLine', this.moveIn.hoverLine);

            this.showTip(this.moveIn.hoverLine, pos);
          }
        }

        if (this.moveIn.type === MoveInType.LineControlPoint) {
          this.hoverLayer.hoverLineCP = this.moveIn.lineControlPoint;
        } else if (this.hoverLayer.hoverLineCP) {
          this.hoverLayer.hoverLineCP = null;
        }
        if (
          this.moveIn.hoverNode !== this.lastHoverNode ||
          this.moveIn.type === MoveInType.HoverAnchors ||
          this.hoverLayer.lasthoverLineCP !== this.hoverLayer.hoverLineCP
        ) {
          this.hoverLayer.lasthoverLineCP = this.hoverLayer.hoverLineCP;
          this.render();
        }

        this.scheduledAnimationFrame = false;
        return;
      }

      // Move out parent element.
      const moveOutX = pos.x + 50 > this.parentElem.clientWidth + this.parentElem.scrollLeft;
      const moveOutY = pos.y + 50 > this.parentElem.clientHeight + this.parentElem.scrollTop;
      if (!this.options.disableMoveOutParent && (moveOutX || moveOutY)) {
        this.dispatch('moveOutParent', pos);

        if (this.options.autoExpandDistance > 0) {
          let resize = false;
          if (pos.x + 50 > this.divLayer.canvas.clientWidth) {
            this.canvas.width += this.options.autoExpandDistance;
            resize = true;
          }
          if (pos.y + 50 > this.divLayer.canvas.clientHeight) {
            this.canvas.height += this.options.autoExpandDistance;
            resize = true;
          }
          if (resize) {
            this.resize({
              width: this.canvas.width,
              height: this.canvas.height,
            });
          }

          this.scroll(
            moveOutX ? this.options.autoExpandDistance / 2 : 0,
            moveOutY ? this.options.autoExpandDistance / 2 : 0
          );
        }
      }

      const moveLeft = pos.x - 100 < this.parentElem.scrollLeft;
      const moveTop = pos.y - 100 < this.parentElem.scrollTop;
      if (moveLeft || moveTop) {
        this.scroll(moveLeft ? -100 : 0, moveTop ? -100 : 0);
      }

      switch (this.moveIn.type) {
        case MoveInType.None:
          this.hoverLayer.dragRect = new Rect(
            this.mouseDown.x,
            this.mouseDown.y,
            pos.x - this.mouseDown.x,
            pos.y - this.mouseDown.y
          );
          break;
        case MoveInType.Nodes:
          if (this.activeLayer.locked()) {
            break;
          }

          const x = pos.x - this.mouseDown.x;
          const y = pos.y - this.mouseDown.y;
          if (x || y) {
            const offset = this.getDockPos(x, y, e.ctrlKey || e.shiftKey || e.altKey);
            this.activeLayer.move(offset.x ? offset.x : x, offset.y ? offset.y : y);
            this.needCache = true;
          }
          break;
        case MoveInType.ResizeCP:
          this.activeLayer.resize(this.moveIn.activeAnchorIndex, this.mouseDown, pos);
          this.dispatch('resizePens', this.activeLayer.pens);
          this.needCache = true;
          break;
        case MoveInType.LineTo:
        case MoveInType.HoverAnchors:
          let arrow = this.data.toArrowType;
          if (this.moveIn.hoverLine) {
            arrow = this.moveIn.hoverLine.toArrow;
          }
          if (this.hoverLayer.line) {
            this.activeLayer.pens = [this.hoverLayer.line];
          }
          this.hoverLayer.lineTo(this.getLineDock(pos), arrow);
          this.needCache = true;
          break;
        case MoveInType.LineFrom:
          this.hoverLayer.lineFrom(this.getLineDock(pos));
          this.needCache = true;
          break;
        case MoveInType.LineMove:
          this.hoverLayer.lineMove(pos, this.mouseDown);
          this.needCache = true;
          break;
        case MoveInType.LineControlPoint:
          this.moveIn.hoverLine.controlPoints[this.moveIn.lineControlPoint.id].x = pos.x;
          this.moveIn.hoverLine.controlPoints[this.moveIn.lineControlPoint.id].y = pos.y;
          this.moveIn.hoverLine.textRect = null;
          if (drawLineFns[this.moveIn.hoverLine.name] && drawLineFns[this.moveIn.hoverLine.name].dockControlPointFn) {
            drawLineFns[this.moveIn.hoverLine.name].dockControlPointFn(
              this.moveIn.hoverLine.controlPoints[this.moveIn.lineControlPoint.id],
              this.moveIn.hoverLine
            );
          }
          this.needCache = true;
          Store.set(this.generateStoreKey('LT:updateLines'), [this.moveIn.hoverLine]);
          break;
        case MoveInType.Rotate:
          if (this.activeLayer.pens.length) {
            this.activeLayer.offsetRotate(this.getAngle(pos));
            this.activeLayer.updateLines();
          }
          this.needCache = true;
          break;
      }

      this.render();
      this.scheduledAnimationFrame = false;
    });
  };

  private onmousedown = (e: MouseEvent) => {
    if (e.button !== 0) return;

    const canvasPos = this.divLayer.canvas.getBoundingClientRect() as DOMRect;
    this.mouseDown = { x: e.x - canvasPos.x, y: e.y - canvasPos.y };
    if (e.altKey) {
      this.divLayer.canvas.style.cursor = 'move';
    }

    if (this.inputObj) {
      this.setNodeText();
    }

    switch (this.moveIn.type) {
      // Click the space.
      case MoveInType.None:
        this.activeLayer.clear();
        this.hoverLayer.clear();
        this.dispatch('space', this.mouseDown);
        break;
      // Click a line.
      case MoveInType.Line:
      case MoveInType.LineControlPoint:
        if (e.ctrlKey || e.shiftKey) {
          this.activeLayer.add(this.moveIn.hoverLine);
          this.dispatch('multi', this.activeLayer.pens);
        } else {
          this.activeLayer.pens = [this.moveIn.hoverLine];
          this.dispatch('line', this.moveIn.hoverLine);
        }

        break;
      case MoveInType.LineMove:
        this.hoverLayer.initLine = new Line(this.moveIn.hoverLine);
        if (this.data.locked || this.moveIn.hoverLine.locked) {
          this.moveIn.hoverLine.click();
        }
      // tslint:disable-next-line:no-switch-case-fall-through
      case MoveInType.LineFrom:
      case MoveInType.LineTo:
        this.activeLayer.pens = [this.moveIn.hoverLine];
        this.dispatch('line', this.moveIn.hoverLine);

        this.hoverLayer.line = this.moveIn.hoverLine;

        break;
      case MoveInType.HoverAnchors:
        this.hoverLayer.line = this.addLine({
          name: this.data.lineName,
          from: new Point(
            this.moveIn.hoverNode.rotatedAnchors[this.moveIn.hoverAnchorIndex].x,
            this.moveIn.hoverNode.rotatedAnchors[this.moveIn.hoverAnchorIndex].y,
            this.moveIn.hoverNode.rotatedAnchors[this.moveIn.hoverAnchorIndex].direction,
            this.moveIn.hoverAnchorIndex,
            this.moveIn.hoverNode.id
          ),
          fromArrow: this.data.fromArrowType,
          to: new Point(
            this.moveIn.hoverNode.rotatedAnchors[this.moveIn.hoverAnchorIndex].x,
            this.moveIn.hoverNode.rotatedAnchors[this.moveIn.hoverAnchorIndex].y
          ),
          toArrow: this.data.toArrowType,
          strokeStyle: this.options.color,
        });
        this.dispatch('anchor', {
          anchor: this.moveIn.hoverNode.rotatedAnchors[this.moveIn.hoverAnchorIndex],
          anchorIndex: this.moveIn.hoverAnchorIndex,
          node: this.moveIn.hoverNode,
          line: this.hoverLayer.line,
        });

      // tslint:disable-next-line:no-switch-case-fall-through
      case MoveInType.Nodes:
        if (!this.moveIn.activeNode) {
          break;
        }

        if (e.ctrlKey || e.shiftKey) {
          if (this.moveIn.hoverNode && this.activeLayer.hasInAll(this.moveIn.hoverNode)) {
            this.activeLayer.setPens([this.moveIn.hoverNode]);
            this.dispatch('node', this.moveIn.hoverNode);
          } else if (!this.activeLayer.has(this.moveIn.activeNode)) {
            this.activeLayer.add(this.moveIn.activeNode);
            if (this.activeLayer.pens.length > 1) {
              this.dispatch('multi', this.activeLayer.pens);
            } else {
              this.dispatch('node', this.moveIn.activeNode);
            }
          }
        } else if (e.altKey) {
          if (this.moveIn.hoverNode) {
            this.activeLayer.setPens([this.moveIn.hoverNode]);
            this.dispatch('node', this.moveIn.hoverNode);
          } else if (this.moveIn.hoverLine) {
            this.activeLayer.setPens([this.moveIn.hoverLine]);
            this.dispatch('line', this.moveIn.hoverLine);
          }
        } else if (this.activeLayer.pens.length < 2) {
          this.activeLayer.setPens([this.moveIn.activeNode]);
          this.dispatch('node', this.moveIn.activeNode);
        }

        if (this.data.locked || this.moveIn.activeNode.locked) {
          this.moveIn.activeNode.click();
        }

        break;
    }

    // Save node rects to move.
    if (this.activeLayer.pens.length) {
      this.activeLayer.saveNodeRects();
    }

    this.render();
  };

  private onmouseup = (e: MouseEvent) => {
    if (!this.mouseDown) return;

    this.mouseDown = null;
    this.lastTranlated.x = 0;
    this.lastTranlated.y = 0;
    this.hoverLayer.dockAnchor = null;
    this.hoverLayer.dockLineX = 0;
    this.hoverLayer.dockLineY = 0;
    this.divLayer.canvas.style.cursor = 'default';

    if (this.hoverLayer.dragRect) {
      this.getPensInRect(this.hoverLayer.dragRect);

      if (this.activeLayer.pens && this.activeLayer.pens.length) {
        this.dispatch('multi', this.activeLayer.pens);
      }
    } else {
      switch (this.moveIn.type) {
        // Add the line.
        case MoveInType.HoverAnchors:
          // New active.
          if (this.hoverLayer.line) {
            let willAddLine: boolean;
            if (this.hoverLayer.line.to.id) {
              if (!this.options.disableRepeatLine) {
                willAddLine = true;
              } else {
                const lines = this.data.pens.filter(
                  (pen) =>
                    pen.type === PenType.Line &&
                    (pen as Line).from.isSameAs(this.hoverLayer.line.from) &&
                    (pen as Line).to.isSameAs(this.hoverLayer.line.to)
                );
                willAddLine = lines.length <= 1;
              }
            } else {
              willAddLine = !this.options.disableEmptyLine && !this.hoverLayer.line.disableEmptyLine;
            }

            if (willAddLine) {
              this.activeLayer.pens = [this.hoverLayer.line];
              this.dispatch('addLine', this.hoverLayer.line);
            } else {
              this.data.pens.pop();
              this.activeLayer.clear();
            }
          }

          this.offscreen.render();

          this.hoverLayer.line = null;
          break;
        case MoveInType.Rotate:
          this.activeLayer.updateRotate();
          break;

        case MoveInType.LineControlPoint:
          Store.set(this.generateStoreKey('pts-') + this.moveIn.hoverLine.id, null);
          break;

        case MoveInType.LineFrom:
        case MoveInType.LineTo:
          if (
            (this.hoverLayer.line.disableEmptyLine || this.options.disableEmptyLine) &&
            (!this.hoverLayer.line.from.id || !this.hoverLayer.line.to.id)
          ) {
            this.needCache = true;
            this.activeLayer.clear();
            this.data.pens.splice(this.findIndex(this.hoverLayer.line), 1);
          }
          break;
      }
    }

    this.hoverLayer.dragRect = null;
    this.render();

    if (this.needCache) {
      this.cache();
    }
    this.needCache = false;
  };

  private ondblclick = (e: MouseEvent) => {
    const canvasPos = this.divLayer.canvas.getBoundingClientRect() as DOMRect;
    if (this.moveIn.hoverNode) {
      this.dispatch('dblclick', this.moveIn.hoverNode);

      if (this.moveIn.hoverNode.getTextRect().hit(new Point(e.x - canvasPos.x, e.y - canvasPos.y))) {
        this.showInput(this.moveIn.hoverNode);
      }

      this.moveIn.hoverNode.dblclick();
    } else if (this.moveIn.hoverLine) {
      this.dispatch('dblclick', this.moveIn.hoverLine);

      if (
        !this.moveIn.hoverLine.text ||
        this.moveIn.hoverLine.getTextRect().hit(new Point(e.x - canvasPos.x, e.y - canvasPos.y))
      ) {
        this.showInput(this.moveIn.hoverLine);
      }

      this.moveIn.hoverLine.dblclick();
    }
  };

  private onkeydown = (key: KeyboardEvent) => {
    if (
      this.data.locked ||
      (key.target as HTMLElement).tagName === 'INPUT' ||
      (key.target as HTMLElement).tagName === 'TEXTAREA'
    ) {
      return;
    }

    let done = false;
    let moveX = 0;
    let moveY = 0;
    switch (key.key) {
      case 'a':
      case 'A':
        this.activeLayer.setPens(this.data.pens);
        done = true;
        break;
      case 'Delete':
      case 'Backspace':
        this.delete();
        break;
      case 'ArrowLeft':
        moveX = -5;
        if (key.ctrlKey) {
          moveX = -1;
        }
        done = true;
        break;
      case 'ArrowUp':
        moveY = -5;
        if (key.ctrlKey) {
          moveY = -1;
        }
        done = true;
        break;
      case 'ArrowRight':
        moveX = 5;
        if (key.ctrlKey) {
          moveX = 1;
        }
        done = true;
        break;
      case 'ArrowDown':
        moveY = 5;
        if (key.ctrlKey) {
          moveY = 1;
        }
        done = true;
        break;
      case 'x':
      case 'X':
        this.cut();
        break;
      case 'c':
      case 'C':
        this.copy();
        break;
      case 'v':
      case 'V':
        this.paste();
        break;
      case 'y':
      case 'Y':
        if (key.ctrlKey) {
          this.redo();
        }
        break;
      case 'z':
      case 'Z':
        if (key.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
        break;
    }

    if (!done) {
      return;
    }

    key.preventDefault();

    if (moveX || moveY) {
      this.activeLayer.saveNodeRects();
      this.activeLayer.move(moveX, moveY);
      this.overflow();
      this.animateLayer.animate();
    }

    this.render();
    this.cache();
  };

  private getMoveIn(pt: Point) {
    this.lastHoverNode = this.moveIn.hoverNode;
    this.lastHoverLine = this.moveIn.hoverLine;
    this.moveIn.type = MoveInType.None;
    this.moveIn.hoverNode = null;
    this.moveIn.lineControlPoint = null;
    this.moveIn.hoverLine = null;
    this.hoverLayer.hoverAnchorIndex = -1;

    if (
      !this.data.locked &&
      !(this.activeLayer.pens.length === 1 && this.activeLayer.pens[0].type) &&
      !this.activeLayer.locked() &&
      this.activeLayer.rotateCPs[0] &&
      this.activeLayer.rotateCPs[0].hit(pt, 15)
    ) {
      this.moveIn.type = MoveInType.Rotate;

      const cursor = this.options.rotateCursor;
      this.divLayer.canvas.style.cursor = cursor.includes('/') ? `url("${cursor}"), auto` : cursor;
      return;
    }

    if (this.activeLayer.pens.length > 1 && pointInRect(pt, this.activeLayer.sizeCPs)) {
      this.moveIn.type = MoveInType.Nodes;
    }

    if (!this.data.locked && !this.activeLayer.locked() && !this.options.hideSizeCP) {
      if (
        this.activeLayer.pens.length > 1 ||
        (!this.activeLayer.pens[0].type && !this.activeLayer.pens[0].hideSizeCP)
      ) {
        for (let i = 0; i < this.activeLayer.sizeCPs.length; ++i) {
          if (this.activeLayer.sizeCPs[i].hit(pt, 10)) {
            this.moveIn.type = MoveInType.ResizeCP;
            this.moveIn.activeAnchorIndex = i;
            this.divLayer.canvas.style.cursor = resizeCursors[i];
            return;
          }
        }
      }
    }

    // In active pen.
    if (!this.data.locked) {
      for (const item of this.activeLayer.pens) {
        if (item instanceof Line && !item.locked) {
          for (let i = 0; i < item.controlPoints.length; ++i) {
            if (!item.locked && item.controlPoints[i].hit(pt, 10)) {
              item.controlPoints[i].id = i;
              this.moveIn.type = MoveInType.LineControlPoint;
              this.moveIn.lineControlPoint = item.controlPoints[i];
              this.moveIn.hoverLine = item;
              this.divLayer.canvas.style.cursor = 'pointer';
              return;
            }
          }
          if (this.inLine(pt, item)) {
            return;
          }
        }
      }
    }

    this.divLayer.canvas.style.cursor = 'default';
    const len = this.data.pens.length;
    for (let i = len - 1; i > -1; --i) {
      if (this.data.pens[i].type === PenType.Node && this.inNode(pt, this.data.pens[i] as Node)) {
        return;
      } else if (this.data.pens[i].type === PenType.Line && this.inLine(pt, this.data.pens[i] as Line)) {
        // 需要优先判断十分在节点锚点上
        // return;
      }
    }
  }

  inChildNode(pt: Point, children: Pen[]) {
    if (!children) {
      return null;
    }

    for (const item of children) {
      if (item.type === PenType.Line) {
        if (this.inLine(pt, item as Line)) {
          return item;
        }
        continue;
      }
      let node = this.inChildNode(pt, (item as Node).children);
      if (node) {
        return node;
      }

      node = this.inNode(pt, item as Node, true);
      if (node) {
        return node;
      }
    }

    return null;
  }

  inNode(pt: Point, node: Node, inChild = false) {
    if (this.data.locked === Lock.NoEvent || !node.visible || node.locked === Lock.NoEvent) {
      return null;
    }

    const child = this.inChildNode(pt, node.children);
    if (child) {
      if (this.moveIn.type !== MoveInType.HoverAnchors) {
        if (child.type === PenType.Line) {
          this.moveIn.activeNode = node;
          this.moveIn.type = MoveInType.Nodes;
        } else if (child.stand) {
          this.moveIn.activeNode = child;
          this.moveIn.type = MoveInType.Nodes;
        } else {
          this.moveIn.activeNode = node;
          this.moveIn.type = MoveInType.Nodes;
        }
      }
      return child;
    }

    if (node.hit(pt)) {
      this.moveIn.hoverNode = node;
      this.moveIn.type = MoveInType.Nodes;
      if (!this.data.locked && !node.locked) {
        this.divLayer.canvas.style.cursor = 'move';
      } else {
        this.divLayer.canvas.style.cursor = this.options.hoverCursor;
      }

      // Too small
      if (
        !this.data.locked &&
        !node.locked &&
        !(this.options.hideAnchor || node.hideAnchor || node.rect.width < 20 || node.rect.height < 20)
      ) {
        for (let j = 0; j < node.rotatedAnchors.length; ++j) {
          if (node.rotatedAnchors[j].hit(pt, 5)) {
            if (!this.mouseDown && node.rotatedAnchors[j].mode === AnchorMode.In) {
              continue;
            }
            this.moveIn.type = MoveInType.HoverAnchors;
            this.moveIn.hoverAnchorIndex = j;
            this.hoverLayer.hoverAnchorIndex = j;
            this.divLayer.canvas.style.cursor = 'crosshair';
            break;
          }
        }
      }

      if (!inChild) {
        this.moveIn.activeNode = this.moveIn.hoverNode;
      }

      return node;
    }

    if (this.options.hideAnchor || node.hideAnchor || this.data.locked || node.locked) {
      return null;
    }

    if (node.hit(pt, 5)) {
      for (let j = 0; j < node.rotatedAnchors.length; ++j) {
        if (node.rotatedAnchors[j].hit(pt, 5)) {
          if (!this.mouseDown && node.rotatedAnchors[j].mode === AnchorMode.In) {
            continue;
          }
          this.moveIn.hoverNode = node;
          this.moveIn.type = MoveInType.HoverAnchors;
          this.moveIn.hoverAnchorIndex = j;
          this.hoverLayer.hoverAnchorIndex = j;
          this.divLayer.canvas.style.cursor = 'crosshair';

          if (!inChild) {
            this.moveIn.activeNode = node;
          }

          return node;
        }
      }
    }

    return null;
  }

  inLine(point: Point, line: Line) {
    if (!line.visible) {
      return null;
    }

    if (line.from.hit(point, 5)) {
      this.moveIn.type = MoveInType.LineFrom;
      this.moveIn.hoverLine = line;
      if (this.data.locked || line.locked) {
        this.divLayer.canvas.style.cursor = this.options.hoverCursor;
      } else {
        this.divLayer.canvas.style.cursor = 'move';
      }
      return line;
    }

    if (line.to.hit(point, 5)) {
      this.moveIn.type = MoveInType.LineTo;
      this.moveIn.hoverLine = line;
      if (this.data.locked || line.locked) {
        this.divLayer.canvas.style.cursor = this.options.hoverCursor;
      } else {
        this.divLayer.canvas.style.cursor = 'move';
      }
      return line;
    }

    if (line.pointIn(point)) {
      this.moveIn.type = MoveInType.LineMove;
      this.moveIn.hoverLine = line;
      this.divLayer.canvas.style.cursor = this.options.hoverCursor;
      if (line.from.id || line.to.id) {
        this.moveIn.type = MoveInType.Line;
      }
      return line;
    }

    return null;
  }

  private getLineDock(point: Point) {
    this.hoverLayer.dockAnchor = null;
    for (const item of this.data.pens) {
      if (item instanceof Node) {
        if (item.rect.hit(point, 10)) {
          this.hoverLayer.node = item;
        }
        for (let i = 0; i < item.rotatedAnchors.length; ++i) {
          if (item.rotatedAnchors[i].mode && item.rotatedAnchors[i].mode !== AnchorMode.In) {
            continue;
          }
          if (item.rotatedAnchors[i].hit(point, 10)) {
            point.id = item.id;
            point.anchorIndex = i;
            point.direction = item.rotatedAnchors[point.anchorIndex].direction;
            point.x = item.rotatedAnchors[point.anchorIndex].x;
            point.y = item.rotatedAnchors[point.anchorIndex].y;
            this.hoverLayer.dockAnchor = item.rotatedAnchors[i];
            break;
          }
        }
      } else if (item instanceof Line) {
        if (item.id === this.hoverLayer.line.id) {
          continue;
        }

        if (item.from.hit(point, 10)) {
          point.x = item.from.x;
          point.y = item.from.y;
          this.hoverLayer.dockAnchor = item.from;
          break;
        }

        if (item.to.hit(point, 10)) {
          point.x = item.to.x;
          point.y = item.to.y;
          this.hoverLayer.dockAnchor = item.to;
          break;
        }

        if (item.controlPoints) {
          for (const cp of item.controlPoints) {
            if (cp.hit(point, 10)) {
              point.x = cp.x;
              point.y = cp.y;
              this.hoverLayer.dockAnchor = cp;
              break;
            }
          }
        }
      }

      if (this.hoverLayer.dockAnchor) {
        break;
      }
    }

    return point;
  }

  private getPensInRect(rect: Rect) {
    if (rect.width < 0) {
      rect.width = -rect.width;
      rect.x = rect.ex;
      rect.ex = rect.x + rect.width;
    }
    if (rect.height < 0) {
      rect.height = -rect.height;
      rect.y = rect.ey;
      rect.ey = rect.y + rect.height;
    }
    this.activeLayer.pens = [];
    for (const item of this.data.pens) {
      if (item.locked === Lock.NoEvent) {
        continue;
      }
      if (item instanceof Node) {
        if (rect.hitByRect(item.rect)) {
          this.activeLayer.add(item);
        }
      }
      if (item instanceof Line) {
        if (rect.hit(item.from) && rect.hit(item.to)) {
          this.activeLayer.add(item);
        }
      }
    }
  }

  private getAngle(pt: Point) {
    if (pt.x === this.activeLayer.rect.center.x) {
      return pt.y <= this.activeLayer.rect.center.y ? 0 : 180;
    }

    if (pt.y === this.activeLayer.rect.center.y) {
      return pt.x < this.activeLayer.rect.center.x ? 270 : 90;
    }

    const x = pt.x - this.activeLayer.rect.center.x;
    const y = pt.y - this.activeLayer.rect.center.y;
    let angle = (Math.atan(Math.abs(x / y)) / (2 * Math.PI)) * 360;
    if (x > 0 && y > 0) {
      angle = 180 - angle;
    } else if (x < 0 && y > 0) {
      angle += 180;
    } else if (x < 0 && y < 0) {
      angle = 360 - angle;
    }
    if (this.activeLayer.pens.length === 1) {
      return angle - this.activeLayer.pens[0].rotate;
    }

    return angle;
  }

  showInput(item: Pen) {
    if (this.data.locked || item.locked || item.hideInput || this.options.hideInput) {
      return;
    }

    this.inputObj = item;
    const textRect = item.getTextRect();
    this.input.value = item.text || '';
    this.input.style.left = textRect.x + 'px';
    this.input.style.top = textRect.y + 'px';
    this.input.style.width = textRect.width + 'px';
    this.input.style.height = textRect.height + 'px';
    this.input.style.zIndex = '1000';
    if (item.rotate / 360) {
      this.input.style.transform = `rotate(${item.rotate}deg)`;
    } else {
      this.input.style.transform = null;
    }
    this.input.focus();
  }

  getRect(pens?: Pen[]) {
    if (!pens) {
      pens = this.data.pens;
    }

    return getRect(pens);
  }

  // Get a dock rect for moving nodes.
  getDockPos(offsetX: number, offsetY: number, noDock?: boolean) {
    this.hoverLayer.dockLineX = 0;
    this.hoverLayer.dockLineY = 0;

    const offset = {
      x: 0,
      y: 0,
    };

    if (noDock || this.options.disableDockLine) {
      return offset;
    }

    let x = 0;
    let y = 0;
    let disX = dockOffset;
    let disY = dockOffset;

    for (const activePt of this.activeLayer.dockWatchers) {
      for (const item of this.data.pens) {
        if (!(item instanceof Node) || this.activeLayer.has(item) || item.name === 'text') {
          continue;
        }

        if (!item.dockWatchers) {
          item.getDockWatchers();
        }
        for (const p of item.dockWatchers) {
          x = Math.abs(p.x - activePt.x - offsetX);
          if (x < disX) {
            disX = -99999;
            offset.x = p.x - activePt.x;
            this.hoverLayer.dockLineX = p.x | 0;
          }

          y = Math.abs(p.y - activePt.y - offsetY);
          if (y < disY) {
            disY = -99999;
            offset.y = p.y - activePt.y;
            this.hoverLayer.dockLineY = p.y | 0;
          }
        }
      }
    }

    return offset;
  }

  cache() {
    if (this.caches.index < this.caches.list.length - 1) {
      this.caches.list.splice(this.caches.index + 1, this.caches.list.length - this.caches.index - 1);
    }
    const data = new TopologyData(this.data);
    this.caches.list.push(data);
    if (this.caches.list.length > this.options.cacheLen) {
      this.caches.list.shift();
    }

    this.caches.index = this.caches.list.length - 1;
  }

  cacheReplace(pens: Pen[]) {
    if (pens && pens.length) {
      const needPenMap = {};
      for (let i = 0, len = pens.length; i < len; i++) {
        const pen = pens[i];
        const id = pen.id;
        if (pen instanceof Node) {
          needPenMap[id] = new Node(pen);
        } else if (pen instanceof Line) {
          needPenMap[id] = new Line(pen);
        }
      }
      const cacheListData: TopologyData = this.caches.list[0];
      if (!cacheListData) {
        return;
      }
      for (let i = 0, len = cacheListData.pens.length; i < len; i++) {
        const id = cacheListData.pens[i].id;
        if (needPenMap[id]) {
          cacheListData.pens[i] = needPenMap[id];
        }
      }
    }
  }

  undo(noRedo = false) {
    if (this.data.locked || this.caches.index < 1) {
      return;
    }

    this.divLayer.clear();
    const data = new TopologyData(this.caches.list[--this.caches.index]);
    this.data.pens.splice(0, this.data.pens.length);
    this.data.pens.push.apply(this.data.pens, data.pens);
    this.render(true);
    this.divLayer.render();

    if (noRedo) {
      this.caches.list.splice(this.caches.index + 1, this.caches.list.length - this.caches.index - 1);
    }

    this.dispatch('undo', this.data);
  }

  redo() {
    if (this.data.locked || this.caches.index > this.caches.list.length - 2) {
      return;
    }
    this.divLayer.clear();
    const data = new TopologyData(this.caches.list[++this.caches.index]);
    this.data.pens.splice(0, this.data.pens.length);
    this.data.pens.push.apply(this.data.pens, data.pens);
    this.render(true);
    this.divLayer.render();

    this.dispatch('redo', this.data);
  }

  toImage(
    type?: string,
    quality?: any,
    callback?: any,
    padding?: { left: number; top: number; right: number; bottom: number },
    thumbnail = true
  ): string {
    let rect = new Rect(0, 0, this.canvas.width, this.canvas.height);
    if (thumbnail) {
      rect = this.getRect();
    }
    if (!padding) {
      padding = {
        left: 10,
        top: 10,
        right: 10,
        bottom: 10,
      };
    }
    rect.x -= padding.left;
    rect.y -= padding.top;
    rect.width += padding.left + padding.right;
    rect.height += padding.top + padding.bottom;
    rect.round();
    const srcRect = rect.clone();
    srcRect.scale(this.offscreen.getDpiRatio(), new Point(0, 0));
    srcRect.round();

    const canvas = document.createElement('canvas');
    canvas.width = srcRect.width;
    canvas.height = srcRect.height;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const ctx = canvas.getContext('2d');
    if (type && type !== 'image/png') {
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(
      this.canvas.canvas,
      srcRect.x,
      srcRect.y,
      srcRect.width,
      srcRect.height,
      0,
      0,
      srcRect.width,
      srcRect.height
    );

    if (callback) {
      canvas.toBlob(callback);
      return '';
    }

    return canvas.toDataURL(type, quality);
  }

  saveAsImage(
    name?: string,
    type?: string,
    quality?: any,
    padding?: { left: number; top: number; right: number; bottom: number },
    thumbnail = true
  ) {
    const a = document.createElement('a');
    a.setAttribute('download', name || 'le5le.topology.png');
    a.setAttribute('href', this.toImage(type, quality, null, padding, thumbnail));
    const evt = document.createEvent('MouseEvents');
    evt.initEvent('click', true, true);
    a.dispatchEvent(evt);
  }

  delete(force?: boolean) {
    const pens: Pen[] = [];
    for (let i = 0; i < this.activeLayer.pens.length; i++) {
      const pen = this.activeLayer.pens[i];
      if (!force && pen.locked) {
        continue;
      }

      const found = this.findIndex(pen);
      if (found > -1) {
        if (this.data.pens[found].type === PenType.Node) {
          this.divLayer.removeDiv(this.data.pens[found] as Node);
        }
        if (this.options.disableEmptyLine) {
          this.delEmptyLines(pen.id);
        }
        pens.push.apply(pens, this.data.pens.splice(found, 1));
        --i;
      }

      this.animateLayer.pens.delete(pen.id);
    }

    if (!pens.length) {
      return;
    }
    this.render(true);
    this.cache();

    this.dispatch('delete', pens);
  }

  delEmptyLines(deleteedId?: string) {
    for (let i = 0; i < this.data.pens.length; i++) {
      if (this.data.pens[i].type !== PenType.Line) {
        continue;
      }

      const line = this.data.pens[i] as Line;
      if (!line.from.id || !line.to.id || line.from.id === deleteedId || line.to.id === deleteedId) {
        this.data.pens.splice(i, 1);
        this.animateLayer.pens.delete(line.id);
        --i;
      }
    }
  }

  removeNode(node: Node) {
    const i = this.findIndex(node);
    if (i > -1) {
      this.divLayer.removeDiv(this.data.pens[i] as Node);
      const nodes = this.data.pens.splice(i, 1);
      this.dispatch('delete', nodes);
    }

    this.render(true);
    this.cache();
  }

  removeLine(line: Line) {
    const i = this.findIndex(line);
    if (i > -1) {
      const lines = this.data.pens.splice(i, 1);
      this.dispatch('delete', lines);
    }

    this.render(true);
    this.cache();
  }

  cut() {
    if (this.data.locked) {
      return;
    }

    this.clipboard = new TopologyData({
      pens: [],
    });
    for (let i = 0; i < this.activeLayer.pens.length; i++) {
      const pen = this.activeLayer.pens[i];
      this.clipboard.pens.push(pen.clone());
      const found = this.findIndex(pen);
      if (found > -1) {
        if (pen.type === PenType.Node) {
          this.divLayer.removeDiv(this.data.pens[found] as Node);
        }
        this.data.pens.splice(found, 1);
        --i;
      }
    }

    this.cache();

    this.activeLayer.clear();
    this.hoverLayer.node = null;
    this.moveIn.hoverLine = null;
    this.moveIn.hoverNode = null;

    this.render();

    this.dispatch('delete', this.clipboard.pens);
  }

  copy() {
    this.clipboard = new TopologyData({
      pens: [],
    });
    for (const pen of this.activeLayer.pens) {
      this.clipboard.pens.push(pen.clone());
    }
    this.dispatch('copy', this.clipboard);
  }

  paste() {
    if (!this.clipboard || this.data.locked) {
      return;
    }

    this.hoverLayer.node = null;
    this.hoverLayer.line = null;

    this.activeLayer.pens = [];

    const idMaps: any = {};
    for (const pen of this.clipboard.pens) {
      if (pen.type === PenType.Node) {
        this.newId(pen, idMaps);
        pen.rect.x += 20;
        pen.rect.ex += 20;
        pen.rect.y += 20;
        pen.rect.ey += 20;
        (pen as Node).init();
      }
      if (pen instanceof Line) {
        pen.id = s8();
        pen.from = new Point(
          pen.from.x + 20,
          pen.from.y + 20,
          pen.from.direction,
          pen.from.anchorIndex,
          idMaps[pen.from.id]
        );
        pen.to = new Point(pen.to.x + 20, pen.to.y + 20, pen.to.direction, pen.to.anchorIndex, idMaps[pen.to.id]);
        const controlPoints = [];
        for (const pt of pen.controlPoints) {
          controlPoints.push(new Point(pt.x + 20, pt.y + 20));
        }
        pen.controlPoints = controlPoints;
      }
      this.data.pens.push(pen);
      this.activeLayer.add(pen);
    }

    this.render();
    this.animate(true);
    this.cache();
    this.copy();

    if (this.clipboard.pens.length > 1) {
      this.dispatch('multi', {
        pens: this.clipboard.pens,
      });
    } else if (this.activeLayer.pens.length > 0) {
      if (this.activeLayer.pens[0].type === PenType.Node) {
        this.dispatch('addNode', this.activeLayer.pens[0]);
      } else if (this.activeLayer.pens[0].type === PenType.Line) {
        this.dispatch('addLine', this.activeLayer.pens[0]);
      }
    }
  }

  newId(node: any, idMaps: any) {
    const old = node.id;
    node.id = s8();
    idMaps[old] = node.id;
    if (node.children) {
      for (const item of node.children) {
        this.newId(item, idMaps);
      }
    }
  }

  animate(autoplay = false) {
    this.animateLayer.readyPlay(null, autoplay);
    this.animateLayer.animate();
  }

  updateProps(cache: boolean = true, pens?: Pen[]) {
    if (!pens) {
      pens = this.activeLayer.pens;
    }
    for (const pen of pens) {
      if (pen instanceof Node) {
        pen.init();
        pen.initRect();
      }
    }

    this.activeLayer.updateLines(pens);
    this.activeLayer.calcControlPoints();
    this.activeLayer.saveNodeRects();

    this.render();
    // tslint:disable-next-line: no-unused-expression
    cache && this.cache();
  }

  lock(lock: Lock) {
    this.data.locked = lock;
    for (const item of this.data.pens) {
      (item as any).addToDiv && (item as any).addToDiv();
    }

    this.dispatch('locked', this.data.locked);
  }

  lockPens(pens: Pen[], lock: Lock) {
    for (const item of this.data.pens) {
      for (const pen of pens) {
        if (item.id === pen.id) {
          item.locked = lock;
          (item as any).addToDiv && (item as any).addToDiv();
          break;
        }
      }
    }

    this.dispatch('lockPens', {
      pens,
      lock,
    });
  }

  up(pen: Pen) {
    const i = this.findIndex(pen);
    if (i > -1 && i !== this.data.pens.length - 1) {
      this.data.pens.splice(i + 2, 0, this.data.pens[i]);
      this.data.pens.splice(i, 1);
    }
  }

  top(pen: Pen) {
    const i = this.findIndex(pen);
    if (i > -1) {
      this.data.pens.push(this.data.pens[i]);
      this.data.pens.splice(i, 1);
    }
  }

  down(pen: Pen) {
    const i = this.findIndex(pen);
    if (i > -1 && i !== 0) {
      this.data.pens.splice(i - 1, 0, this.data.pens[i]);
      this.data.pens.splice(i + 1, 1);
    }
  }

  bottom(pen: Pen) {
    const i = this.findIndex(pen);
    if (i > -1) {
      this.data.pens.unshift(this.data.pens[i]);
      this.data.pens.splice(i + 1, 1);
    }
  }

  combine(pens?: Pen[], stand = false) {
    if (!pens) {
      pens = this.activeLayer.pens;
    }

    const rect = this.getRect(pens);
    for (const item of pens) {
      const i = this.findIndex(item);
      if (i > -1) {
        this.data.pens.splice(i, 1);
      }
    }

    let node = new Node({
      name: 'combine',
      rect: new Rect(rect.x, rect.y, rect.width, rect.height),
      text: '',
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      strokeStyle: 'transparent',
      children: [],
    });

    for (let i = 0; i < pens.length; ++i) {
      if (pens[i].type === PenType.Node && rect.width === pens[i].rect.width && rect.height === pens[i].rect.height) {
        node = pens[i] as Node;
        if (!node.children) {
          node.children = [];
        }
        pens.splice(i, 1);
        break;
      }
    }

    for (const item of pens) {
      item.stand = stand;
      item.parentId = node.id;
      item.calcRectInParent(node);
      node.children.push(item);
    }
    this.data.pens.push(node);

    this.activeLayer.setPens([node]);

    this.dispatch('node', node);

    this.cache();
  }

  uncombine(node?: Pen) {
    if (!node) {
      node = this.activeLayer.pens[0];
    }

    if (!(node instanceof Node)) {
      return;
    }

    for (const item of node.children) {
      item.parentId = undefined;
      item.rectInParent = undefined;
      item.locked = Lock.None;
      this.data.pens.push(item);
    }

    const i = this.findIndex(node);
    if (i > -1 && node.name === 'combine') {
      this.data.pens.splice(i, 1);
    } else {
      node.children = null;
    }

    this.cache();

    this.activeLayer.clear();
    this.hoverLayer.clear();
  }

  find(idOrTag: string, pens?: Pen[]) {
    if (!pens) {
      pens = this.data.pens;
    }

    const result: Pen[] = [];
    pens.forEach((item) => {
      if (item.id === idOrTag || item.tags.indexOf(idOrTag) > -1) {
        result.push(item);
      }

      if ((item as any).children) {
        result.push.apply(result, this.find(idOrTag, (item as any).children));
      }
    });

    if (result.length === 1) {
      return result[0];
    }

    return result;
  }

  findIndex(pen: Pen) {
    for (let i = 0; i < this.data.pens.length; ++i) {
      if (pen.id === this.data.pens[i].id) {
        return i;
      }
    }

    return -1;
  }

  translate(x: number, y: number, process?: boolean) {
    if (!process) {
      this.lastTranlated.x = 0;
      this.lastTranlated.y = 0;
    }
    const offsetX = x - this.lastTranlated.x;
    const offsetY = y - this.lastTranlated.y;

    for (const item of this.data.pens) {
      item.translate(offsetX, offsetY);
    }
    this.animateLayer.pens.forEach((pen) => {
      if (pen instanceof Line) {
        pen.translate(offsetX, offsetY);
      }
    });

    this.lastTranlated.x = x;
    this.lastTranlated.y = y;
    this.render();
    this.cache();

    this.dispatch('translate', { x, y });
  }

  // scale for scaled canvas:
  //   > 1, expand
  //   < 1, reduce
  scale(scale: number, center?: Point) {
    if (this.data.scale * scale < this.options.minScale || this.data.scale * scale > this.options.maxScale) {
      return;
    }

    this.data.scale *= scale;
    !center && (center = this.getRect().center);

    for (const item of this.data.pens) {
      item.scale(scale, center);
    }
    this.animateLayer.pens.forEach((pen) => {
      if (pen instanceof Line) {
        pen.scale(scale, center);
      }
    });
    Store.set(this.generateStoreKey('LT:scale'), this.data.scale);

    this.render();
    const rect = this.overflow();
    let x = 0;
    let y = 0;
    if (rect.x < 0) {
      x = -rect.x + this.options.autoExpandDistance / 2;
    }
    if (rect.ex > this.canvas.width) {
      x = this.canvas.width - rect.ex - this.options.autoExpandDistance / 2;
    }
    if (rect.y < 0) {
      y = -rect.y + this.options.autoExpandDistance / 2;
    }
    if (rect.ey > this.canvas.height) {
      y = this.canvas.height - rect.ey - this.options.autoExpandDistance / 2;
    }
    this.translate(x, y);
    this.cache();

    this.dispatch('scale', this.data.scale);
  }

  // scale for origin canvas:
  scaleTo(scale: number) {
    this.scale(scale / this.data.scale);
    this.data.scale = scale;
  }

  round() {
    for (const item of this.data.pens) {
      if (item instanceof Node) {
        item.round();
      }
    }
  }

  private generateStoreKey(key) {
    return `${this.id}-${key}`;
  }

  private createMarkdownTip() {
    this.tipMarkdown = document.createElement('div');
    this.tipMarkdown.style.position = 'fixed';
    this.tipMarkdown.style.zIndex = '-1';
    this.tipMarkdown.style.left = '-9999px';
    this.tipMarkdown.style.width = '260px';
    this.tipMarkdown.style.outline = 'none';
    this.tipMarkdown.style.border = '1px solid #333';
    this.tipMarkdown.style.backgroundColor = 'rgba(0,0,0,.7)';
    this.tipMarkdown.style.color = '#fff';
    this.tipMarkdown.style.padding = '10px 15px';
    this.tipMarkdown.style.overflowY = 'auto';
    this.tipMarkdown.style.minHeight = '30px';
    this.tipMarkdown.style.maxHeight = '260px';
    document.body.appendChild(this.tipMarkdown);
  }

  private showTip(data: Pen, pos: { x: number; y: number }) {
    if (!this.data.locked || !data || (!data.markdown && !data.tipId && !data.title) || data.id === this.tip) {
      return;
    }

    if (data.title) {
      this.divLayer.canvas.title = data.title;
      this.tip = data.id;
      return;
    }

    if (data.tipId) {
      this.tipElem = document.getElementById(data.tipId);
    }

    let elem = this.tipElem;
    if (data.markdown) {
      elem = this.tipMarkdown;
      const marked = (window as any).marked;
      if (marked) {
        this.tipMarkdown.innerHTML = marked(data.markdown);
      } else {
        this.tipMarkdown.innerHTML = data.markdown;
      }
      const a = this.tipMarkdown.getElementsByTagName('A');
      for (let i = 0; i < a.length; ++i) {
        a[i].setAttribute('target', '_blank');
      }
    }

    const parentRect = this.parentElem.getBoundingClientRect();
    const elemRect = elem.getBoundingClientRect();
    let x = parentRect.left + data.rect.x;
    let y = pos.y + parentRect.top;
    if (data instanceof Node) {
      // x = parentRect.left + (data as Node).rect.center.x - elemRect.width / 2;
      y = parentRect.top + (data as Node).rect.ey;
    }

    x -= this.parentElem.scrollLeft;
    y -= this.parentElem.scrollTop;

    if (x < 0) {
      x = 0;
    }
    if (x + elemRect.width > document.body.clientWidth) {
      x = document.body.clientWidth - elemRect.width;
    }
    if (y + elemRect.height > document.body.clientHeight) {
      y = document.body.clientHeight - elemRect.height;
    }

    elem.style.position = 'fixed';
    elem.style.left = x + 'px';
    elem.style.top = y + 'px';
    elem.style.zIndex = '100';
    this.tip = data.id;

    this.dispatch('tip', elem);
  }

  private hideTip() {
    if (!this.tip) {
      return;
    }

    this.tipMarkdown.style.left = '-9999px';
    this.tipMarkdown.style.zIndex = '-1';
    if (this.tipElem) {
      this.tipElem.style.left = '-9999px';
      this.tipElem.style.zIndex = '-1';
      this.tipElem = null;
    }
    this.divLayer.canvas.title = '';

    this.tip = '';
  }

  scroll(x: number, y: number) {
    if (this.scrolling) {
      return;
    }
    this.scrolling = true;
    this.parentElem.scrollLeft += x;
    this.parentElem.scrollTop += y;
    setTimeout(() => {
      this.scrolling = false;
    }, 700);
  }

  toComponent(pens?: Pen[]) {
    if (!pens) {
      pens = this.data.pens;
    }

    const rect = this.getRect(pens);
    let node = new Node({
      name: 'combine',
      rect: new Rect(rect.x, rect.y, rect.width, rect.height),
      text: '',
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 0,
      paddingBottom: 0,
      strokeStyle: 'transparent',
      children: [],
    });

    for (const item of pens) {
      if (item.type === PenType.Node && rect.width === item.rect.width && rect.height === item.rect.height) {
        node = item as Node;
        if (!node.children) {
          node.children = [];
        }
        break;
      }
    }

    for (const item of pens) {
      if (item !== node) {
        item.parentId = node.id;
        item.calcRectInParent(node);
        node.children.push(item);
      }
    }

    return node;
  }

  clearBkImg() {
    this.canvas.clearBkImg();
  }

  dispatch(event: string, data: any) {
    if (this.options.on) {
      this.options.on(event, data);
    }
  }

  getValue(idOrTag: string, attr = 'text') {
    let pen: Pen;
    this.data.pens.forEach((item) => {
      if (item.id === idOrTag || item.tags.indexOf(idOrTag) > -1) {
        pen = item;
        return;
      }
    });

    return pen[attr];
  }

  setValue(idOrTag: string, val: any, attr = 'text') {
    let pen: Pen;
    this.data.pens.forEach((item) => {
      if (item.id === idOrTag || item.tags.indexOf(idOrTag) > -1) {
        pen = item;
        return;
      }
    });

    pen[attr] = val;
  }

  createGrid() {
    this.gridElem.style.position = 'absolute';
    this.gridElem.style.display = 'none';
    this.gridElem.style.left = '0';
    this.gridElem.style.top = '0';
    this.gridElem.innerHTML = `<svg class="svg-grid" width="100%" height="100%" style="position:absolute;left:0;right:0;top:0;bottom:0"
      xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="grid" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#f3f3f3" stroke-width="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
    </svg>`;
    this.parentElem.appendChild(this.gridElem);
  }

  showGrid(show?: boolean) {
    if (show === undefined) {
      show = this.data.grid;
    }
    this.gridElem.style.width = this.canvas.width + 'px';
    this.gridElem.style.height = this.canvas.height + 'px';
    this.gridElem.style.display = show ? 'block' : 'none';
  }

  setLineName(name: 'curve' | 'line' | 'polyline' | 'mind', render = true) {
    this.data.pens.forEach((pen: Pen) => {
      if (pen.type) {
        (pen as Line).name = name;
        (pen as Line).calcControlPoints();
      }
    });

    render && this.render();
  }

  destroy() {
    this.subcribe.unsubscribe();
    this.subcribeRender.unsubscribe();
    this.subcribeImage.unsubscribe();
    this.subcribeAnimateEnd.unsubscribe();
    this.subcribeAnimateMoved.unsubscribe();
    this.subcribeMediaEnd.unsubscribe();
    this.animateLayer.destroy();
    this.divLayer.destroy();
    document.body.removeChild(this.tipMarkdown);
    window.removeEventListener('resize', this.winResize);
    this.closeSocket();
    (window as any).topology = null;
  }
}
