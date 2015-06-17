// Copyright (c) Microsoft Corporation.  All Rights Reserved. Licensed under the MIT License. See License.txt in the project root for license information.
/// <reference path="../../../../../typings/require.d.ts" />

import _Global = require("../../Core/_Global");

import Animations = require("../../Animations");
import BindingList = require("../../BindingList");
import ControlProcessor = require("../../ControlProcessor");
import Promise = require("../../Promise");
import Scheduler = require("../../Scheduler");

import _Base = require("../../Core/_Base");
import _BaseUtils = require("../../Core/_BaseUtils");
import _Control = require("../../Utilities/_Control");
import _Dispose = require("../../Utilities/_Dispose");
import _ElementUtilities = require("../../Utilities/_ElementUtilities");
import _ErrorFromName = require("../../Core/_ErrorFromName");
import _Events = require("../../Core/_Events");
import _Hoverable = require("../../Utilities/_Hoverable");
import _KeyboardBehavior = require("../../Utilities/_KeyboardBehavior");
import _Log = require("../../Core/_Log");
import _Resources = require("../../Core/_Resources");
import _Signal = require("../../_Signal");
import _TabContainer = require("../../Utilities/_TabContainer");
import _TransitionAnimation = require("../../Animations/_TransitionAnimation");
import _WriteProfilerMark = require("../../Core/_WriteProfilerMark");

import _Constants = require("./_Constants");
import _PivotItem = require("./_Item");

// Force-load PivotItem
_PivotItem.PivotItem;

require(["require-style!less/styles-pivot"]);
require(["require-style!less/colors-pivot"]);

"use strict";

var _EventNames = {
    selectionChanged: "selectionchanged",
    itemAnimationStart: "itemanimationstart",
    itemAnimationEnd: "itemanimationend",
};

var strings = {
    get duplicateConstruction() { return "Invalid argument: Controls may only be instantiated one time for each DOM element"; },
    get duplicateItem() { return _Resources._getWinJSString("ui/duplicateItem").value; },
    get invalidContent() { return "Invalid content: Pivot content must be made up of PivotItems."; },
    get pivotAriaLabel() { return _Resources._getWinJSString("ui/pivotAriaLabel").value; },
    get pivotViewportAriaLabel() { return _Resources._getWinJSString("ui/pivotViewportAriaLabel").value; }
};

var supportsSnap = !!(_ElementUtilities._supportsSnapPoints && _Global["HTMLElement"].prototype.msZoomTo);
var PT_MOUSE = _ElementUtilities._MSPointerEvent.MSPOINTER_TYPE_MOUSE || "mouse";
var PT_TOUCH = _ElementUtilities._MSPointerEvent.MSPOINTER_TYPE_TOUCH || "touch";
var Keys = _ElementUtilities.Key;

var _headerSlideAnimationDuration = 250;
var _invalidMeasurement = -1;

function pivotDefaultHeaderTemplate(item: { header: any }) {
    var element = _Global.document.createTextNode(typeof item.header === "object" ? JSON.stringify(item.header) : ('' + item.header));
    return element;
}

export class Pivot {
    static supportedForProcessing = true;

    _customLeftHeader: HTMLElement;
    _customRightHeader: HTMLElement;
    _element: HTMLElement;
    _headerAreaElement: HTMLElement;
    _headerItemsElement: HTMLElement;
    _headersContainerElement: HTMLElement;
    _surfaceElement: HTMLElement;
    _titleElement: HTMLElement;
    _viewportElement: HTMLElement;

    _animateToPrevious: boolean;
    _cachedRTL: boolean;
    _disposed = false;
    _elementPointerDownPoint: { x: number; y: number; type: string; inHeaders: boolean; time: number; };
    _firstLoad = true;
    _headerItemsElWidth: number;
    _headersState: typeof headersStates.nop;
    _hidePivotItemAnimation = Promise.wrap<any>();
    _id: string;
    _items: BindingList.List<_PivotItem.PivotItem>;
    _loadPromise = Promise.wrap<any>();
    _navigationHandled: boolean;
    _pendingItems: BindingList.List<_PivotItem.PivotItem>;
    _pendingRefresh = false;
    _pointerType = PT_MOUSE;
    _rtl = false;
    _selectedIndex = 0;
    _showPivotItemAnimation = Promise.wrap<any>();
    _slideHeadersAnimation = Promise.wrap<any>();
    _tabContainer: _TabContainer.TabContainer;
    _viewportElWidth: number;
    _winKeyboard: _KeyboardBehavior._WinKeyboard;

    /// <field type="HTMLElement" domElement="true" hidden="true" locid="WinJS.UI.Pivot.element" helpKeyword="WinJS.UI.Pivot.element">
    /// Gets the DOM element that hosts the Pivot.
    /// </field>
    get element() {
        return this._element;
    }

    /// <field type="Boolean" locid="WinJS.UI.Pivot.locked" helpKeyword="WinJS.UI.Pivot.locked">
    /// Gets or sets a value that specifies whether the Pivot is locked to the current item.
    /// </field>
    get locked() {
        return _ElementUtilities.hasClass(this.element, _Constants._ClassNames.pivotLocked);
    }
    set locked(value: boolean) {
        _ElementUtilities[value ? "addClass" : "removeClass"](this.element, _Constants._ClassNames.pivotLocked);
        if (value) {
            this._hideNavButtons();
        }
    }

    /// <field type="WinJS.Binding.List" locid="WinJS.UI.Pivot.items" helpKeyword="WinJS.UI.Pivot.items">
    /// Gets or sets the WinJS.Binding.List of PivotItem objects that belong to this Pivot.
    /// </field>
    get items() {
        if (this._pendingItems) {
            return this._pendingItems;
        }
        return this._items;
    }
    set items(value: BindingList.List<_PivotItem.PivotItem>) {
        var resetScrollPosition = !this._pendingItems;
        this._pendingItems = value;
        this._refresh();
    }

    /// <field type="Number" integer="true" locid="WinJS.UI.Pivot.selectedIndex" helpKeyword="WinJS.UI.Pivot.selectedIndex">
    /// Gets or sets the index of the item in view. This property is useful for restoring a previous view when your app launches or resumes.
    /// </field>
    get selectedIndex() {
        if (this.items.length === 0) {
            return -1;
        }
        return this._selectedIndex;
    }
    set selectedIndex(value: number) {
        if (value >= 0 && value < this.items.length) {
            if (this._pendingRefresh) {
                this._selectedIndex = value;
            } else {
                this._loadItem(value);
            }
        }
    }

    /// <field type="WinJS.UI.PivotItem" locid="WinJS.UI.Pivot.selectedItem" helpKeyword="WinJS.UI.Pivot.selectedItem">
    /// Gets or sets the item in view. This property is useful for restoring a previous view when your app launches or resumes.
    /// </field>
    get selectedItem() {
        return this.items.getAt(this.selectedIndex);
    }
    set selectedItem(value: _PivotItem.PivotItem) {
        var index = this.items.indexOf(value);
        if (index !== -1) {
            this.selectedIndex = index;
        }
    }

    constructor(element?: HTMLElement, options: any = {}) {
        /// <signature helpKeyword="WinJS.UI.Pivot.Pivot">
        /// <summary locid="WinJS.UI.Pivot.constructor">
        /// Creates a new Pivot control.
        /// </summary>
        /// <param name="element" type="HTMLElement" domElement="true" isOptional="true" locid="WinJS.UI.Pivot.constructor_p:element">
        /// The DOM element that hosts the Pivot control.
        /// </param>
        /// <param name="options" type="Object" isOptional="true" locid="WinJS.UI.Pivot.constructor_p:options">
        /// An object that contains one or more property/value pairs to apply to the new control.
        /// Each property of the options object corresponds to one of the control's properties or events.
        /// Event names must begin with "on". For example, to provide a handler for the index changed event,
        /// add a property named "onselectionchanged" to the options object and set its value to the event handler.
        /// </param>
        /// <returns type="WinJS.UI.Pivot" locid="WinJS.UI.Pivot.constructor_returnValue">
        /// The new Pivot.
        /// </returns>
        /// </signature>
        element = element || _Global.document.createElement("DIV");
        if (element["winControl"]) {
            throw new _ErrorFromName("WinJS.UI.Pivot.DuplicateConstruction", strings.duplicateConstruction);
        }

        this._handleItemChanged = this._handleItemChanged.bind(this);
        this._handleItemInserted = this._handleItemInserted.bind(this);
        this._handleItemMoved = this._handleItemMoved.bind(this);
        this._handleItemRemoved = this._handleItemRemoved.bind(this);
        this._handleItemReload = this._handleItemReload.bind(this);
        this._resizeHandler = this._resizeHandler.bind(this);
        this._updatePointerType = this._updatePointerType.bind(this);

        this._id = element.id || _ElementUtilities._uniqueID(element);

        // Attaching JS control to DOM element
        element["winControl"] = this;
        this._element = element;
        this._element.setAttribute("role", "tablist");
        if (!this._element.getAttribute("aria-label")) {
            this._element.setAttribute('aria-label', strings.pivotAriaLabel);
        }
        _ElementUtilities.addClass(this.element, _Constants._ClassNames.pivot);
        _ElementUtilities.addClass(this.element, "win-disposable");
        _ElementUtilities._addEventListener(this.element, "pointerenter", this._updatePointerType);
        _ElementUtilities._addEventListener(this.element, "pointerout", this._updatePointerType);

        // Title element
        this._titleElement = _Global.document.createElement("DIV");
        this._titleElement.style.display = "none";
        _ElementUtilities.addClass(this._titleElement, _Constants._ClassNames.pivotTitle);
        this._element.appendChild(this._titleElement);

        // Header Area
        this._headerAreaElement = _Global.document.createElement("DIV");
        _ElementUtilities.addClass(this._headerAreaElement, _Constants._ClassNames.pivotHeaderArea);
        this._element.appendChild(this._headerAreaElement);

        // Header Items
        this._headerItemsElement = _Global.document.createElement("DIV");
        _ElementUtilities.addClass(this._headerItemsElement, _Constants._ClassNames.pivotHeaderItems);
        this._headerAreaElement.appendChild(this._headerItemsElement);
        this._headerItemsElWidth = null;

        // Headers Container
        this._headersContainerElement = _Global.document.createElement("DIV");
        this._headersContainerElement.tabIndex = 0;
        _ElementUtilities.addClass(this._headersContainerElement, _Constants._ClassNames.pivotHeaders);
        this._headersContainerElement.addEventListener("keydown", this._headersKeyDown.bind(this));
        this._headerItemsElement.appendChild(this._headersContainerElement);
        this._element.addEventListener("click", this._elementClickedHandler.bind(this));
        _ElementUtilities._addEventListener(this._headersContainerElement, "pointerenter", this._showNavButtons.bind(this));
        _ElementUtilities._addEventListener(this._headersContainerElement, "pointerout", this._hideNavButtons.bind(this));
        this._winKeyboard = new _KeyboardBehavior._WinKeyboard(this._headersContainerElement);
        this._tabContainer = new _TabContainer.TabContainer(this._headersContainerElement);

        // Custom Headers
        this._customLeftHeader = _Global.document.createElement("DIV");
        _ElementUtilities.addClass(this._customLeftHeader, _Constants._ClassNames.pivotHeaderLeftCustom);
        this._headerAreaElement.insertBefore(this._customLeftHeader, this._headerAreaElement.children[0]);
        this._customRightHeader = _Global.document.createElement("DIV");
        _ElementUtilities.addClass(this._customRightHeader, _Constants._ClassNames.pivotHeaderRightCustom);
        this._headerAreaElement.appendChild(this._customRightHeader);

        // Viewport
        this._viewportElement = _Global.document.createElement("DIV");
        this._viewportElement.className = _Constants._ClassNames.pivotViewport;
        this._element.appendChild(this._viewportElement);
        this._viewportElement.setAttribute("role", "group");
        this._viewportElement.setAttribute("aria-label", strings.pivotViewportAriaLabel);
        this.element.addEventListener("mselementresize", this._resizeHandler);
        _ElementUtilities._resizeNotifier.subscribe(this.element, this._resizeHandler);
        this._viewportElWidth = null;

        // Surface
        this._surfaceElement = _Global.document.createElement("DIV");
        this._surfaceElement.className = _Constants._ClassNames.pivotSurface;
        this._viewportElement.appendChild(this._surfaceElement);

        this._headersState = headersStates.nop;

        // Navigation handlers
        if (supportsSnap) {
            this._viewportElement.addEventListener("MSManipulationStateChanged", this._MSManipulationStateChangedHandler.bind(this));
        } else {
            _ElementUtilities.addClass(this.element, _Constants._ClassNames.pivotNoSnap);
            _ElementUtilities._addEventListener(this._element, "pointerdown", this._elementPointerDownHandler.bind(this));
            _ElementUtilities._addEventListener(this._element, "pointerup", this._elementPointerUpHandler.bind(this));
        }

        // This internally assigns this.items which causes item to be used (even from options) before selectedIndex
        this._parse();

        options = _BaseUtils._shallowCopy(options);
        if (options.items) {
            // Set this first so selectedIndex and selectedItem can work against the new items.
            this.items = options.items;
            delete options.items;
        }

        _Control.setOptions(this, options);

        this._refresh();

        this._writeProfilerMark("constructor,StopTM");
    }

    // Lifecycle Methods
    _applyProperties() {
        if (this._disposed) {
            return;
        }

        if (this._pendingItems) {
            this._updateEvents(this._items, this._pendingItems);
            this._items = this._pendingItems;
            this._pendingItems = null;
            // Remove any declaratively specified pivot items before attachItems.
            while (this.element.firstElementChild !== this._titleElement) {
                var toRemove = this.element.firstElementChild;
                toRemove.parentNode.removeChild(toRemove);
            }
            _ElementUtilities.empty(this._surfaceElement);
        }

        attachItems(this);

        this._cachedRTL = _Global.getComputedStyle(this._element, null).direction === "rtl";
        headersStates.common.refreshHeadersState(this, true);
        this._pendingRefresh = false;

        this.selectedIndex = this._selectedIndex;
        this._firstLoad = false;
        this._recenterUI();

        function attachItems(pivot: Pivot) {
            for (var i = 0, len = pivot.items.length; i < len; i++) {
                var item = pivot._items.getAt(i);

                if (item.element.parentNode === pivot._surfaceElement) {
                    throw new _ErrorFromName("WinJS.UI.Pivot.DuplicateItem", strings.duplicateItem);
                }

                item.element.style.visibility = "hidden";
                item.element.style.opacity = "0";

                pivot._surfaceElement.appendChild(item.element);
            }
        }
    }

    _parse() {
        var pivotItems: _PivotItem.PivotItem[] = [];
        var pivotItemEl = this.element.firstElementChild;

        while (pivotItemEl !== this._titleElement) {
            ControlProcessor.processAll(pivotItemEl);

            var pivotItemContent: _PivotItem.PivotItem = pivotItemEl["winControl"];
            if (pivotItemContent) {
                pivotItems.push(pivotItemContent);
            } else {
                throw new _ErrorFromName("WinJS.UI.Pivot.InvalidContent", strings.invalidContent);
            }

            var nextItemEl = pivotItemEl.nextElementSibling;
            pivotItemEl = nextItemEl;
        }

        this.items = new BindingList.List(pivotItems);
    }

    _refresh() {
        if (this._pendingRefresh) {
            return;
        }

        // This is to coalesce property setting operations such as items and scrollPosition.
        this._pendingRefresh = true;

        this._loadPromise.then(() => {
            Scheduler.schedule(this._applyProperties.bind(this), Scheduler.Priority.high);
        });
    }

    _resizeHandler() {
        if (this._disposed || this._pendingRefresh) {
            return;
        }

        var oldViewportWidth = this._getViewportWidth();
        var oldHeaderItemsWidth = this._getHeaderItemsWidth();
        this._invalidateMeasures();
        if (oldViewportWidth !== this._getViewportWidth() || oldHeaderItemsWidth !== this._getHeaderItemsWidth()) {
            // Measures have changed
            _Log.log && _Log.log('_resizeHandler, viewport from:' + oldViewportWidth + " to: " + this._getViewportWidth());
            _Log.log && _Log.log('_resizeHandler, headers from:' + oldHeaderItemsWidth + " to: " + this._getHeaderItemsWidth());

            this._hidePivotItemAnimation && this._hidePivotItemAnimation.cancel();
            this._showPivotItemAnimation && this._showPivotItemAnimation.cancel();
            this._slideHeadersAnimation && this._slideHeadersAnimation.cancel();

            this._recenterUI();
            this._headersState.handleResize();
        } else {
            _Log.log && _Log.log('_resizeHandler worthless resize');
        }
    }

    // Navigation Methods
    _activateHeader(headerElement: HTMLElement) {
        if (this.locked) {
            return;
        }

        var index = this._items.indexOf(headerElement["_item"]);
        if (index !== this.selectedIndex) {
            this._headersState.activateHeader(headerElement);
        } else {
            // Move focus into content for Narrator.
            _ElementUtilities._setActiveFirstFocusableElement(this.selectedItem.element);
        }
    }

    _goNext() {
        if (this.selectedIndex < this._items.length - 1) {
            this.selectedIndex++;
        } else {
            this.selectedIndex = 0;
        }
    }

    _goPrevious() {
        this._animateToPrevious = true;
        if (this.selectedIndex > 0) {
            this.selectedIndex--;
        } else {
            this.selectedIndex = this._items.length - 1;
        }
        this._animateToPrevious = false;
    }

    _loadItem(index: number) {
        this._cachedRTL = _Global.getComputedStyle(this._element, null).direction === "rtl";
        this._hidePivotItemAnimation && this._hidePivotItemAnimation.cancel();
        this._showPivotItemAnimation && this._showPivotItemAnimation.cancel();
        this._slideHeadersAnimation && this._slideHeadersAnimation.cancel();

        var goPrev = this._animateToPrevious;
        var oldItem = this._items.getAt(this.selectedIndex);
        oldItem && this._hidePivotItem(oldItem.element, goPrev);
        this._selectedIndex = index;

        var newItem = this._items.getAt(index);
        var selectionChangedDetail = {
            index: index,
            direction: goPrev ? "backwards" : "forward",
            item: newItem
        };
        this._fireEvent(_EventNames.selectionChanged, true, false, selectionChangedDetail);

        this._loadPromise = this._loadPromise.then(() => {
            this._loadPromise = Promise.join([newItem._process(), this._hidePivotItemAnimation]).then(() => {
                if (this._disposed) {
                    return;
                }
                this._recenterUI();
                this._showPivotItem(newItem.element, goPrev).then(() => {
                    if (this._disposed) {
                        return;
                    }
                    this._fireEvent(_EventNames.itemAnimationEnd, true, false, null);
                });
            });
        });
    }

    _recenterUI() {
        _ElementUtilities.setScrollPosition(this._viewportElement, { scrollLeft: this._getViewportWidth() });
    }

    // Utility Methods
    _fireEvent(type: string, canBubble: boolean, cancelable: boolean, detail: any) {
        // Returns true if ev.preventDefault() was not called
        var event = <CustomEvent>_Global.document.createEvent("CustomEvent");
        event.initCustomEvent(type, !!canBubble, !!cancelable, detail);
        return this.element.dispatchEvent(event);
    }

    _getHeaderItemsWidth() {
        if (!this._headerItemsElWidth) {
            this._headerItemsElWidth = parseFloat(_Global.getComputedStyle(this._headerItemsElement).width);
        }
        return this._headerItemsElWidth || _invalidMeasurement;
    }

    _getViewportWidth() {
        if (!this._viewportElWidth) {
            this._viewportElWidth = parseFloat(_Global.getComputedStyle(this._viewportElement).width);
            if (supportsSnap) {
                this._viewportElement.style[_BaseUtils._browserStyleEquivalents["scroll-snap-points-x"].scriptName] = "snapInterval(0%, " + Math.ceil(this._viewportElWidth) + "px)";
            }
        }
        return this._viewportElWidth || _invalidMeasurement;
    }

    _invalidateMeasures() {
        this._viewportElWidth = this._headerItemsElWidth = null;
    }

    _updateEvents(oldItems: BindingList.List<_PivotItem.PivotItem>, newItems: BindingList.List<_PivotItem.PivotItem>) {
        if (oldItems) {
            oldItems.removeEventListener("itemchanged", this._handleItemChanged);
            oldItems.removeEventListener("iteminserted", this._handleItemInserted);
            oldItems.removeEventListener("itemmoved", this._handleItemMoved);
            oldItems.removeEventListener("itemremoved", this._handleItemRemoved);
            oldItems.removeEventListener("reload", this._handleItemReload);
        }

        if (newItems) {
            newItems.addEventListener("itemchanged", this._handleItemChanged);
            newItems.addEventListener("iteminserted", this._handleItemInserted);
            newItems.addEventListener("itemmoved", this._handleItemMoved);
            newItems.addEventListener("itemremoved", this._handleItemRemoved);
            newItems.addEventListener("reload", this._handleItemReload);
        }
    }

    _writeProfilerMark(text: string) {
        var message = "WinJS.UI.Pivot:" + this._id + ":" + text;
        _WriteProfilerMark(message);
        _Log.log && _Log.log(message, null, "pivotprofiler");
    }


    // Datasource Mutation Handlers
    _handleItemChanged(ev: CustomEvent) {
        // Change is triggered by binding list setAt() API.
        if (this._pendingItems) {
            return;
        }

        var index = ev.detail.index;
        var newItem = ev.detail.newValue;
        var oldItem = ev.detail.oldValue;
        if (newItem.element !== oldItem.element) {
            if (newItem.element.parentNode === this._surfaceElement) {
                throw new _ErrorFromName("WinJS.UI.Pivot.DuplicateItem", strings.duplicateItem);
            }

            newItem.element.style.visibility = "hidden";
            newItem.element.style.opacity = 0;

            this._surfaceElement.insertBefore(newItem.element, oldItem.element);
            this._surfaceElement.removeChild(oldItem.element);

            if (index === this.selectedIndex) {
                this.selectedIndex = index;
            }
        }

        this._headersState.render();
        headersStates.common.refreshHeadersState(this, true);
    }

    _handleItemInserted(ev: CustomEvent) {
        // Insert is triggered by binding list insert APIs such as splice(), push(), and unshift().
        if (this._pendingItems) {
            return;
        }

        var index = ev.detail.index;
        var item = ev.detail.value;

        if (item.element.parentNode === this._surfaceElement) {
            throw new _ErrorFromName("WinJS.UI.Pivot.DuplicateItem", strings.duplicateItem);
        }

        item.element.style.visibility = "hidden";
        item.element.style.opacity = 0;

        if (index < this.items.length - 1) {
            this._surfaceElement.insertBefore(item.element, this.items.getAt(index + 1).element);
        } else {
            this._surfaceElement.appendChild(item.element);
        }

        if (index <= this.selectedIndex) {
            this._selectedIndex++;
        }

        if (this._items.length === 1) {
            this.selectedIndex = 0;
        }

        this._headersState.render();
        headersStates.common.refreshHeadersState(this, true);
    }

    _handleItemMoved(ev: CustomEvent) {
        // Move is triggered by binding list move() API.
        if (this._pendingItems) {
            return;
        }

        var oldIndex = ev.detail.oldIndex;
        var newIndex = ev.detail.newIndex;
        var item = ev.detail.value;

        if (newIndex < this.items.length - 1) {
            this._surfaceElement.insertBefore(item.element, this.items.getAt(newIndex + 1).element);
        } else {
            this._surfaceElement.appendChild(item.element);
        }

        if (oldIndex < this.selectedIndex && newIndex >= this.selectedIndex) {
            this._selectedIndex--;
        } else if (newIndex > this.selectedIndex && oldIndex <= this.selectedIndex) {
            this._selectedIndex++;
        } else if (oldIndex === this.selectedIndex) {
            this.selectedIndex = this.selectedIndex;
        }

        this._headersState.render();
        headersStates.common.refreshHeadersState(this, true);
    }

    _handleItemReload() {
        // Reload is triggered by large operations on the binding list such as reverse(). This causes
        // _pendingItems to be true which ignores future insert/remove/modified/moved events until the new
        // items list is applied.
        this.items = this.items;
    }

    _handleItemRemoved(ev: CustomEvent) {
        // Removed is triggered by binding list removal APIs such as splice(), pop(), and shift().
        if (this._pendingItems) {
            return;
        }

        var item = ev.detail.value;
        var index = ev.detail.index;

        this._surfaceElement.removeChild(item.element);

        if (index < this.selectedIndex) {
            this._selectedIndex--;
        } else if (index === this._selectedIndex) {
            this.selectedIndex = Math.min(this.items.length - 1, this._selectedIndex);
        }

        this._headersState.render();
        headersStates.common.refreshHeadersState(this, true);
    }


    // Event Handlers
    _elementClickedHandler(e: MouseEvent) {
        if (this.locked || this._navigationHandled) {
            this._navigationHandled = false;
            return;
        }

        var header: HTMLElement;
        var src = <HTMLElement>e.target;
        if (_ElementUtilities.hasClass(src, _Constants._ClassNames.pivotHeader)) {
            // UIA invoke clicks on the real header elements.
            header = src;
        } else {
            var hitSrcElement = false;
            var hitTargets = _ElementUtilities._elementsFromPoint(e.clientX, e.clientY);
            if (hitTargets &&
                // Make sure there aren't any elements obscuring the Pivot headers.
                // WinJS.Utilities._elementsFromPoint sorts by z order.
                hitTargets[0] === this._viewportElement) {
                for (var i = 0, len = hitTargets.length; i < len; i++) {
                    if (hitTargets[i] === src) {
                        hitSrcElement = true;
                    }
                    if (_ElementUtilities.hasClass(<HTMLElement>hitTargets[i], _Constants._ClassNames.pivotHeader)) {
                        header = <HTMLElement>hitTargets[i];
                    }
                }
            }

            if (!hitSrcElement) {
                // The click's coordinates and source element do not correspond so we
                // can't trust the coordinates. Ignore the click. This case happens in
                // clicks triggered by UIA invoke because UIA invoke uses the top left
                // of the window as the coordinates of every click.
                header = null;
            }
        }

        if (header) {
            this._activateHeader(header);
        }
    }

    _elementPointerDownHandler(e: PointerEvent) {
        if (supportsSnap) {
            return;
        }
        var element = <HTMLElement>e.target;
        this._elementPointerDownPoint = { x: e.clientX, y: e.clientY, type: e.pointerType || "mouse", time: Date.now(), inHeaders: this._headersContainerElement.contains(element) };
    }

    _elementPointerUpHandler(e: PointerEvent) {
        if (!this._elementPointerDownPoint || this.locked) {
            this._elementPointerDownPoint = null;
            return;
        }

        var element = <HTMLElement>e.target;
        var filterDistance = 32;
        var dyDxThresholdRatio = 0.4;

        var dy = Math.abs(e.clientY - this._elementPointerDownPoint.y);
        var dx = e.clientX - this._elementPointerDownPoint.x;
        var thresholdY = Math.abs(dx * dyDxThresholdRatio);

        var doSwipeDetection =
            // Check vertical threshold to prevent accidental swipe detection during vertical pan
            dy < thresholdY
            // Check horizontal threshold to prevent accidental swipe detection when tapping
            && Math.abs(dx) > filterDistance
            // Check that input type is Touch, however, if touch detection is not supported then we do detection for any input type
            && (!_ElementUtilities._supportsTouchDetection || (this._elementPointerDownPoint.type === e.pointerType && e.pointerType === PT_TOUCH))
            // Check if content swipe navigation is disabled, if it is we still run swipe detection if both the up and down points are in the headers container element
            && (!this.element.classList.contains(_Constants._ClassNames.pivotDisableContentSwipeNavigation) || (this._elementPointerDownPoint.inHeaders && this._headersContainerElement.contains(element)));

        this._navigationHandled = false;
        if (doSwipeDetection) {
            // Swipe navigation detection

            // Simulate inertia by multiplying dx by a polynomial function of dt
            var dt = Date.now() - this._elementPointerDownPoint.time;
            dx *= Math.max(1, Math.pow(350 / dt, 2));
            dx = this._rtl ? -dx : dx;

            var vwDiv4 = this._getViewportWidth() / 4;
            if (dx < -vwDiv4) {
                this._goNext();
                this._navigationHandled = true;
            } else if (dx > vwDiv4) {
                this._goPrevious();
                this._navigationHandled = true;
            }
        }
        if (!this._navigationHandled) {
            // Detect header click
            while (element !== null && !_ElementUtilities.hasClass(element, _Constants._ClassNames.pivotHeader)) {
                element = element.parentElement;
            }
            if (element !== null) {
                this._activateHeader(element);
                this._navigationHandled = true;
            }
        }
        this._elementPointerDownPoint = null;
    }

    _headersKeyDown(e: KeyboardEvent) {
        if (this.locked) {
            return;
        }

        if (e.keyCode === Keys.leftArrow || e.keyCode === Keys.pageUp) {
            this._rtl ? this._goNext() : this._goPrevious();
            e.preventDefault();
        } else if (e.keyCode === Keys.rightArrow || e.keyCode === Keys.pageDown) {
            this._rtl ? this._goPrevious() : this._goNext();
            e.preventDefault();
        }
    }

    _hideNavButtons() {
        _ElementUtilities.removeClass(this._headersContainerElement, _Constants._ClassNames.pivotShowNavButtons);
    }

    _hidePivotItem(element: HTMLElement, goPrevious: boolean) {
        this._hidePivotItemAnimation = _TransitionAnimation.executeTransition(element, {
            property: "opacity",
            delay: 0,
            duration: 83,
            timing: "linear",
            from: "",
            to: "0",
        })
            .then(() => {
                element.style.visibility = "hidden";
            });
        return this._hidePivotItemAnimation;
    }

    _MSManipulationStateChangedHandler(e: MSManipulationEvent) {
        if (e.target !== this._viewportElement) {
            // Ignore sub scroller manipulations.
            return;
        }

        if (e.currentState === 2 /* Inertia */) {
            var delta = e["inertiaDestinationX"] - this._getViewportWidth();
            if (delta > 0) {
                this._goNext();
            } else if (delta < 0) {
                this._goPrevious();
            }
        }
    }

    _updatePointerType(e: PointerEvent) {
        this._pointerType = e.pointerType || PT_MOUSE;
    }

    _showNavButtons(e: PointerEvent) {
        if (this.locked || (e && e.pointerType === PT_TOUCH)) {
            return;
        }
        _ElementUtilities.addClass(this._headersContainerElement, _Constants._ClassNames.pivotShowNavButtons);
    }

    _showPivotItem(element: HTMLElement, goPrevious: boolean) {
        this._fireEvent(_EventNames.itemAnimationStart, true, false, null);

        element.style.visibility = "";
        this._showPivotItemAnimation = Promise.join([
            _TransitionAnimation.executeTransition(element, {
                property: "opacity",
                delay: 0,
                duration: 167,
                timing: "linear",
                from: "0",
                to: "",
            }),
            _TransitionAnimation.executeTransition(element, {
                property: _BaseUtils._browserStyleEquivalents["transform"].cssName,
                delay: 0,
                duration: 167,
                timing: "linear",
                from: "translateX(" + (goPrevious ? "-20px" : "20px") + ")",
                to: "",
            })
        ]);
        return this._showPivotItemAnimation;
    }
}


// Publish to WinJS namespace
var toPublish = _BaseUtils._merge(Pivot, _Events.eventMixin);
toPublish["_listeners"] = {};

var headersStates = {
    nop: {
        // Called when transitioning away from this state
        exit: function () { },

        // Render headers
        render: function () { },

        // Called when a header is activated, i.e. tapped, clicked, arrow keyed to
        activateHeader: function (header: HTMLElement) { },

        // Called when the selectedIndex changed
        handleNavigation: function (goPrevious: boolean, index: number, oldIndex: number) { },

        // Called when the control size changed
        handleResize: function () { },

        // Called when the header string of the specified pivotItem changed
        handleHeaderChanged: function (pivotItem: _PivotItem.PivotItem) { }
    },

    common: {
        // This object contains a set of static helper functions for other states to use

        headersContainerLeadingMargin: 12,

        headerHorizontalMargin: 12,

        getCumulativeHeaderWidth: function headersState_getCumulativeHeaderWidth(pivot: Pivot, index: number) {
            // Computes the total width of headers from 0 up to the specified index
            if (index === 0) {
                return 0;
            }

            var originalLength = pivot._headersContainerElement.children.length;
            for (var i = 0; i < index; i++) {
                var header = headersStates.common.renderHeader(pivot, i, false);
                pivot._headersContainerElement.appendChild(header);
            }

            var width = 0;
            var leftElement = <HTMLElement>(pivot._rtl ? pivot._headersContainerElement.lastElementChild : pivot._headersContainerElement.children[originalLength]);
            var rightElement = <HTMLElement>(pivot._rtl ? pivot._headersContainerElement.children[originalLength] : pivot._headersContainerElement.lastElementChild);
            width = (rightElement.offsetLeft + rightElement.offsetWidth) - leftElement.offsetLeft;
            width += 2 * headersStates.common.headerHorizontalMargin;

            for (var i = 0; i < index; i++) {
                pivot._headersContainerElement.removeChild(pivot._headersContainerElement.lastElementChild);
            }
            return width;
        },

        refreshHeadersState: function headersState_refreshHeadersState(pivot: Pivot, invalidateCache: boolean) {
            // Measures the cumulative header length and switches headers states if necessary
            if (invalidateCache) {
                this._cachedWidth = 0;
            }
            var width = this._cachedWidth || this.getCumulativeHeaderWidth(pivot, pivot.items.length);
            this._cachedWidth = width;

            if (width > pivot._getHeaderItemsWidth() && !(pivot._headersState instanceof headersStates.overflowState)) {
                pivot._headersState.exit();
                pivot._headersState = new headersStates.overflowState(pivot);
            } else if (width <= pivot._getHeaderItemsWidth() && !(pivot._headersState instanceof headersStates.staticState)) {
                pivot._headersState.exit();
                pivot._headersState = new headersStates.staticState(pivot);
            }
        },

        renderHeader: function headersState_renderHeader(pivot: Pivot, index: number, aria: boolean) {
            // Renders a single header
            var template = _ElementUtilities._syncRenderer(pivotDefaultHeaderTemplate);
            var item = pivot.items.getAt(index);

            var headerContainerEl = _Global.document.createElement("BUTTON");
            headerContainerEl.setAttribute("type", "button");
            headerContainerEl.style.marginLeft = headerContainerEl.style.marginRight = headersStates.common.headerHorizontalMargin + "px";
            _ElementUtilities.addClass(headerContainerEl, _Constants._ClassNames.pivotHeader);
            headerContainerEl["_item"] = item;
            headerContainerEl["_pivotItemIndex"] = index;
            template(item, headerContainerEl);

            function ariaSelectedMutated() {
                if (pivot._disposed) {
                    return;
                }

                if (pivot._headersContainerElement.contains(headerContainerEl) &&
                    index !== pivot.selectedIndex &&
                    headerContainerEl.getAttribute('aria-selected') === "true") {
                    // Ignore aria selected changes on selected item.
                    // By selecting another tab we change to it.
                    pivot.selectedIndex = index;
                }
            }
            if (aria) {
                headerContainerEl.setAttribute('aria-selected', "" + (index === pivot.selectedIndex));
                headerContainerEl.setAttribute('role', 'tab');
                new _ElementUtilities._MutationObserver(ariaSelectedMutated).observe(headerContainerEl, { attributes: true, attributeFilter: ["aria-selected"] });
            }

            return headerContainerEl;
        },

        updateHeader: function headersState_updateHeader(pivot: Pivot, item: _PivotItem.PivotItem) {
            // Updates the label of a header
            var index = pivot.items.indexOf(item);
            var headerElement = <HTMLElement>pivot._headersContainerElement.children[index];
            headerElement.innerHTML = "";

            var template = _ElementUtilities._syncRenderer(pivotDefaultHeaderTemplate);
            template(item, headerElement);
        },

        setActiveHeader: function headersState_setActiveHeader(pivot: Pivot, newSelectedHeader: HTMLElement, currentSelectedHeader: HTMLElement) {
            // Updates the selected header and clears the previously selected header if applicable
            var focusWasInHeaders = false;
            if (currentSelectedHeader) {
                currentSelectedHeader.classList.remove(_Constants._ClassNames.pivotHeaderSelected);
                currentSelectedHeader.setAttribute("aria-selected", "false");
                focusWasInHeaders = pivot._headersContainerElement.contains(<HTMLElement>_Global.document.activeElement);
            }

            newSelectedHeader.classList.add(_Constants._ClassNames.pivotHeaderSelected);
            newSelectedHeader.setAttribute("aria-selected", "true");
            focusWasInHeaders && pivot._headersContainerElement.focus();
        }
    },

    staticState: _Base.Class.define(function staticState_ctor(pivot: Pivot) {
        // This state renders headers statically in the order they appear in the binding list.
        // There is no animation when the selectedIndex changes, only the highlighted header changes.

        this.pivot = pivot;
        this._firstRender = true;
        this._transitionAnimation = Promise.wrap();

        if (pivot._headersContainerElement.children.length && _TransitionAnimation.isAnimationEnabled()) {
            // We transitioned from another headers state, do transition animation

            // Calculate the offset from the selected header to where the selected header should be in static layout
            var selectedHeader = <HTMLElement>pivot._headersContainerElement.querySelector("." + _Constants._ClassNames.pivotHeaderSelected);
            var start = 0;
            var end = 0;
            if (pivot._rtl) {
                start = selectedHeader.offsetLeft + selectedHeader.offsetWidth + headersStates.common.headerHorizontalMargin;
                end = pivot._getHeaderItemsWidth() - headersStates.common.getCumulativeHeaderWidth(pivot, pivot.selectedIndex) - headersStates.common.headersContainerLeadingMargin;
                end += parseFloat(pivot._headersContainerElement.style.marginLeft);
            } else {
                start = selectedHeader.offsetLeft;
                start += parseFloat(pivot._headersContainerElement.style.marginLeft); // overflow state has a hidden first element that we need to account for
                end = headersStates.common.getCumulativeHeaderWidth(pivot, pivot.selectedIndex) + headersStates.common.headersContainerLeadingMargin + headersStates.common.headerHorizontalMargin;
            }
            var offset = start - end;

            this.render();

            // Offset every header by the calculated offset so there is no visual difference after the render call
            var transformProperty = _BaseUtils._browserStyleEquivalents["transform"].cssName;
            var transformValue = "translateX(" + offset + "px)";
            for (var i = 0, l = pivot._headersContainerElement.children.length; i < l; i++) {
                (<HTMLElement>pivot._headersContainerElement.children[i]).style[transformProperty] = transformValue;
            }

            // Transition headers back to their original location
            this._transitionAnimation = _TransitionAnimation.executeTransition(
                pivot._headersContainerElement.querySelectorAll("." + _Constants._ClassNames.pivotHeader), {
                    property: transformProperty,
                    delay: 0,
                    duration: _headerSlideAnimationDuration,
                    timing: "ease-out",
                    to: ""
                });
        }
    }, {
            exit: function staticState_exit() {
                this._transitionAnimation.cancel();
            },

            render: function staticState_render() {
                var pivot = this.pivot;
                if (pivot._pendingRefresh || !pivot._items) {
                    return;
                }

                _Dispose._disposeElement(pivot._headersContainerElement);
                _ElementUtilities.empty(pivot._headersContainerElement);

                if (pivot._rtl) {
                    pivot._headersContainerElement.style.marginLeft = "0px";
                    pivot._headersContainerElement.style.marginRight = headersStates.common.headersContainerLeadingMargin + "px";
                } else {
                    pivot._headersContainerElement.style.marginLeft = headersStates.common.headersContainerLeadingMargin + "px";
                    pivot._headersContainerElement.style.marginRight = "0px";
                }
                pivot._viewportElement.style.overflow = pivot.items.length === 1 ? "hidden" : "";

                if (pivot.items.length) {
                    for (var i = 0; i < pivot.items.length; i++) {
                        var header = headersStates.common.renderHeader(pivot, i, true);
                        pivot._headersContainerElement.appendChild(header);

                        if (i === pivot.selectedIndex) {
                            header.classList.add(_Constants._ClassNames.pivotHeaderSelected);
                        }
                    }

                    pivot._tabContainer.childFocus = pivot._headersContainerElement.children[pivot.selectedIndex];
                }
                this._firstRender = false;
            },

            activateHeader: function staticState_activateHeader(headerElement: HTMLElement) {
                var currentActiveHeader = this.pivot._headersContainerElement.children[this.pivot.selectedIndex];
                headersStates.common.setActiveHeader(this.pivot, headerElement, currentActiveHeader);
                this.pivot._animateToPrevious = headerElement["pivotItemIndex"] < this.pivot.selectedIndex;
                this.pivot.selectedIndex = headerElement["_pivotItemIndex"];
            },

            handleNavigation: function staticState_handleNavigation(goPrevious: boolean, index: number, oldIndex: number) {
                if (this._firstRender) {
                    this.render();
                }
                headersStates.common.setActiveHeader(this.pivot, this.pivot._headersContainerElement.children[index], this.pivot._headersContainerElement.children[oldIndex]);
                this.pivot._tabContainer.childFocus = this.pivot._headersContainerElement.children[index];
            },

            handleResize: function staticState_handleResize() {
                headersStates.common.refreshHeadersState(this.pivot, false);
            },

            handleHeaderChanged: function staticState_handleHeaderChanged(pivotItem: _PivotItem.PivotItem) {
                headersStates.common.updateHeader(this.pivot, pivotItem);
                headersStates.common.refreshHeadersState(this.pivot, true);
            }
        }),

    overflowState: _Base.Class.define(function overflowState_ctor(pivot: Pivot) {
        // This state renders the selected header always left-aligned (in ltr) and
        // animates the headers when the selectedIndex changes.

        this.pivot = pivot;
        this._blocked = false;
        this._firstRender = true;
        this._transitionAnimation = Promise.wrap();
        pivot._slideHeadersAnimation = Promise.wrap();

        if (pivot._headersContainerElement.children.length && _TransitionAnimation.isAnimationEnabled()) {
            // We transitioned from another headers state, do transition animation
            var that = this;
            var done = function () {
                that._blocked = false;
                that.render();
            };
            this._blocked = true;

            // Calculate the offset from the selected header to the leading edge of the container
            var selectedHeader = <HTMLElement>pivot._headersContainerElement.querySelector("." + _Constants._ClassNames.pivotHeaderSelected);
            var start = 0;
            var end = 0;
            if (pivot._rtl) {
                start = pivot._getHeaderItemsWidth() - headersStates.common.headersContainerLeadingMargin;
                end = selectedHeader.offsetLeft;
                end += headersStates.common.headerHorizontalMargin;
                end += selectedHeader.offsetWidth;
                end += parseFloat(pivot._headersContainerElement.style.marginLeft);
            } else {
                start = headersStates.common.headersContainerLeadingMargin;
                end = selectedHeader.offsetLeft;
                end -= headersStates.common.headerHorizontalMargin;
                end += parseFloat(pivot._headersContainerElement.style.marginLeft);
            }
            var offset = start - end;

            // Duplicate all the headers up to the selected header so when the transition occurs there will be
            // headers on the trailing end of the container to replace the ones that are being transitioned off-screen
            for (var i = 0; i < pivot.selectedIndex; i++) {
                pivot._headersContainerElement.appendChild(pivot._headersContainerElement.children[i].cloneNode(true));
            }

            // Transition headers to the leading edge of the container, then render the container as usual
            var transformProperty = _BaseUtils._browserStyleEquivalents["transform"].cssName;
            this._transitionAnimation = _TransitionAnimation.executeTransition(
                pivot._headersContainerElement.querySelectorAll("." + _Constants._ClassNames.pivotHeader), {
                    property: transformProperty,
                    delay: 0,
                    duration: _headerSlideAnimationDuration,
                    timing: "ease-out",
                    to: "translateX(" + offset + "px)"
                }).then(done, done);
        }
    }, {
            exit: function overflowState_exit() {
                this._transitionAnimation.cancel();
                this.pivot._slideHeadersAnimation.cancel();
            },

            render: function overflowState_render(goPrevious: boolean) {
                var pivot = this.pivot;
                if (this._blocked || pivot._pendingRefresh || !pivot._items) {
                    return;
                }

                var restoreFocus = pivot._headersContainerElement.contains(_Global.document.activeElement);

                _Dispose._disposeElement(pivot._headersContainerElement);
                _ElementUtilities.empty(pivot._headersContainerElement);


                if (pivot._items.length === 1) {
                    var header = headersStates.common.renderHeader(pivot, 0, true);
                    header.classList.add(_Constants._ClassNames.pivotHeaderSelected);
                    pivot._headersContainerElement.appendChild(header);

                    pivot._viewportElement.style.overflow = "hidden";
                    pivot._headersContainerElement.style.marginLeft = "0px";
                    pivot._headersContainerElement.style.marginRight = "0px";
                } else if (pivot._items.length > 1) {
                    // We always render 1 additional header before the current item.
                    // When going backwards, we render 2 additional headers, the first one as usual, and the second one for
                    // fading out the previous last header.
                    var numberOfHeadersToRender = pivot._items.length + (goPrevious ? 2 : 1);
                    var maxHeaderWidth = pivot._headerItemsWidth * 0.8;
                    var indexToRender = pivot.selectedIndex - 1;

                    if (pivot._viewportElement.style.overflow) {
                        pivot._viewportElement.style.overflow = "";
                    }

                    for (var i = 0; i < numberOfHeadersToRender; i++) {
                        if (indexToRender === -1) {
                            indexToRender = pivot._items.length - 1;
                        } else if (indexToRender === pivot._items.length) {
                            indexToRender = 0;
                        }

                        var header = headersStates.common.renderHeader(pivot, indexToRender, true);
                        pivot._headersContainerElement.appendChild(header);

                        if (header.offsetWidth > maxHeaderWidth) {
                            header.style.textOverflow = "ellipsis";
                            header.style.width = maxHeaderWidth + "px";
                        }

                        if (indexToRender === pivot.selectedIndex) {
                            header.classList.add(_Constants._ClassNames.pivotHeaderSelected);
                        }
                        indexToRender++;
                    }
                    if (!pivot._firstLoad && !this._firstRender) {
                        var start: string, end: string;
                        if (goPrevious) {
                            start = "";
                            end = "0";
                        } else {
                            start = "0";
                            end = "";
                        }

                        var lastHeader = pivot._headersContainerElement.children[numberOfHeadersToRender - 1];
                        lastHeader.style.opacity = start;
                        var lastHeaderFadeInDuration = 0.167;
                        lastHeader.style[_BaseUtils._browserStyleEquivalents["transition"].scriptName] = "opacity " + _TransitionAnimation._animationTimeAdjustment(lastHeaderFadeInDuration) + "s";
                        _Global.getComputedStyle(lastHeader).opacity;
                        lastHeader.style.opacity = end;
                    }

                    pivot._headersContainerElement.children[0].setAttribute("aria-hidden", "true");
                    pivot._headersContainerElement.style.marginLeft = "0px";
                    pivot._headersContainerElement.style.marginRight = "0px";
                    var leadingMargin = pivot._rtl ? "marginRight" : "marginLeft";
                    var firstHeader = pivot._headersContainerElement.children[0];
                    var leadingSpace = _ElementUtilities.getTotalWidth(firstHeader) - headersStates.common.headersContainerLeadingMargin;
                    if (firstHeader !== pivot._headersContainerElement.children[0]) {
                        // Calling getTotalWidth caused a layout which can trigger a synchronous resize which in turn
                        // calls renderHeaders. We can ignore this one since its the old headers which are not in the DOM.
                        return;
                    }
                    pivot._headersContainerElement.style[leadingMargin] = (-1 * leadingSpace) + "px";

                    // Create header track nav button elements
                    pivot._prevButton = _Global.document.createElement("button");
                    pivot._prevButton.setAttribute("type", "button");
                    _ElementUtilities.addClass(pivot._prevButton, _Constants._ClassNames.pivotNavButton);
                    _ElementUtilities.addClass(pivot._prevButton, _Constants._ClassNames.pivotNavButtonPrev);
                    pivot._prevButton.addEventListener("click", function () {
                        if (pivot.locked) {
                            return;
                        }
                        pivot._rtl ? pivot._goNext() : pivot._goPrevious();
                    });
                    pivot._headersContainerElement.appendChild(pivot._prevButton);
                    pivot._prevButton.style.left = pivot._rtl ? "0px" : leadingSpace + "px";

                    pivot._nextButton = _Global.document.createElement("button");
                    pivot._nextButton.setAttribute("type", "button");
                    _ElementUtilities.addClass(pivot._nextButton, _Constants._ClassNames.pivotNavButton);
                    _ElementUtilities.addClass(pivot._nextButton, _Constants._ClassNames.pivotNavButtonNext);
                    pivot._nextButton.addEventListener("click", function () {
                        if (pivot.locked) {
                            return;
                        }
                        pivot._rtl ? pivot._goPrevious() : pivot._goNext();
                    });
                    pivot._headersContainerElement.appendChild(pivot._nextButton);
                    pivot._nextButton.style.right = pivot._rtl ? leadingSpace + "px" : "0px";
                }
                var firstHeaderIndex = pivot._headersContainerElement.children.length > 1 ? 1 : 0;
                pivot._tabContainer.childFocus = pivot._headersContainerElement.children[firstHeaderIndex];
                if (restoreFocus) {
                    pivot._headersContainerElement.focus();
                }
                this._firstRender = false;
            },

            activateHeader: function overflowState_activateHeader(headerElement: HTMLElement) {
                if (!headerElement.previousSibling) {
                    // prevent clicking the previous header
                    return;
                }
                this.pivot.selectedIndex = headerElement["_pivotItemIndex"];
            },

            handleNavigation: function overflowState_handleNavigation(goPrevious: boolean, index: number, oldIndex: number) {
                var pivot = this.pivot;
                if (this._blocked || index < 0 || pivot._firstLoad) {
                    this.render(goPrevious);
                    return;
                }

                var targetHeader: HTMLElement;

                if (goPrevious) {
                    targetHeader = pivot._headersContainerElement.children[0];
                } else {
                    if (index < oldIndex) {
                        index += pivot._items.length;
                    }
                    targetHeader = pivot._headersContainerElement.children[1 + index - oldIndex];
                }

                if (!targetHeader) {
                    this.render(goPrevious);
                    return;
                }

                // Update the selected one:
                _ElementUtilities.removeClass(pivot._headersContainerElement.children[1], _Constants._ClassNames.pivotHeaderSelected);
                _ElementUtilities.addClass(targetHeader, _Constants._ClassNames.pivotHeaderSelected);

                var rtl = pivot._rtl;

                function offset(element: HTMLElement) {
                    if (rtl) {
                        return (<HTMLElement>element.offsetParent).offsetWidth - element.offsetLeft - element.offsetWidth;
                    } else {
                        return element.offsetLeft;
                    }
                }

                var endPosition = offset(pivot._headersContainerElement.children[1]) - offset(targetHeader);
                if (rtl) {
                    endPosition *= -1;
                }

                function headerCleanup() {
                    if (pivot._disposed) {
                        return;
                    }

                    pivot._headersState.render(goPrevious);
                    pivot._slideHeadersAnimation = Promise.wrap();
                }

                var headerAnimation: any;
                if (_TransitionAnimation.isAnimationEnabled()) {
                    headerAnimation = _TransitionAnimation.executeTransition(
                        pivot._headersContainerElement.querySelectorAll("." + _Constants._ClassNames.pivotHeader),
                        {
                            property: _BaseUtils._browserStyleEquivalents["transform"].cssName,
                            delay: 0,
                            duration: _headerSlideAnimationDuration,
                            timing: "ease-out",
                            to: "translateX(" + endPosition + "px)"
                        });
                } else {
                    headerAnimation = Promise.wrap();
                }

                pivot._slideHeadersAnimation = headerAnimation.then(headerCleanup, headerCleanup);
            },

            handleResize: function overflowState_handleResize() {
                headersStates.common.refreshHeadersState(this.pivot, false);
            },

            handleHeaderChanged: function overflowState_handleHeaderChanged(pivotItem: _PivotItem.PivotItem) {
                this.render();
                headersStates.common.refreshHeadersState(this.pivot, true);
            }
        })
};