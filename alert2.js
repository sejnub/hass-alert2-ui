const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
const html = LitElement.prototype.html;
const css = LitElement.prototype.css;
const NOTIFICATIONS_ENABLED  = 'enabled'
const NOTIFICATIONS_DISABLED = 'disabled'
const NOTIFICATION_SNOOZE = 'snooze'
const VERSION = 'v1.5.3  (internal 47)';
console.log(`alert2 ${VERSION}`);

let queueMicrotask =  window.queueMicrotask || ((handler) => window.setTimeout(handler, 1));
function jFireEvent(elem, evName, params) {
    const event = new Event(evName, {
        bubbles: true,
        cancelable: Boolean(false),
        composed: true,
    });
    event.detail = params;
    elem.dispatchEvent(event);
}
function showToast(elem, amsg) { jFireEvent(elem, "hass-notification", { message: amsg }); }


// A custom card that lists alerts that have fired recently
class Alert2Overview extends LitElement {
    // https://lit.dev/docs/components/properties/
    // has good description of reactive properties
    static properties = {
        _config: {state: true},
        _sortedDispInfos: {state: true},
        _cardHelpers: {state: true},
        _ackAllInProgress: {state: true},
        _showVersion: {state: true},
        _sliderVal: {state: true}
    }
    constructor() {
        super();
        this._sortedDispInfos = [];
        this._updateTimer = null;
        this._cardHelpers = null;
        this._ackAllInProgress = false;
        this._showVersion = false;
        this._sliderValArr = [
            { str: '1 minute', secs: 60 },
            { str: '10 minutes', secs: 10*60 },
            { str: '1 hour', secs: 60*60 },
            { str: '4 hours', secs: 4*60*60 },
            { str: '1 day', secs: 24*60*60 },
            { str: '4 days', secs: 4*24*60*60 },
            { str: '2 weeks', secs: 2*7*24*60*60 }
        ]
        window.loadCardHelpers().then(hs => { this._cardHelpers = hs; });
        this._hass = null;
        // The only indication we get of state changes is hass updating.
        // To prevent scanning through all entitites in hass on each update,
        // we do two optimizations.
        // 1. We throttle scans to at most once per _updateCooldownMs.
        // 2. We keep _alert2StatesMap, a map of the state objects of all alert/alert2
        //    entities. So when we do a scan in jrefresh(), we first do a check to see if any
        //    alert2 entities changed.  If any changed, then we do the heavier
        //    look through entities and check dates/times.
        //
        this._alert2StatesMap = new Map(); // map entity_id -> state object
        this._updateCooldown =  { timer: undefined, rerun: false };
        this._updateCooldownMs = 1000;
        
        this._sliderVal = 3;// 4 hours
        // Check for entities aging out of UI window 6 times each selected interval.
        // e.g., 6 times ever 4 hours
        this._updateIntervalFactor = 6; 
    }
    set hass(newHass) {
        const oldHass = this._hass;
        this._hass = newHass;
        if (this.shadowRoot && this._hass) {
            this.shadowRoot.querySelectorAll("hui-alert2-entity-row").forEach((elem) => {
                elem.hass = this._hass;
            });
        }
        if (this._updateCooldown.timer) {
            this._updateCooldown.rerun = true;
            //console.log('set hass - deferring');
            return;
        } else {
            //console.log('set hass - doing lightRefresh', this._updateCooldownMs);
            this._updateCooldown.rerun = false;
            this._updateCooldown.timer = window.setTimeout(() => {
                this._updateCooldown.timer = undefined;
                if (this._updateCooldown.rerun) { queueMicrotask(()=> { this.jrefresh(false); }); }
            }, this._updateCooldownMs);
            queueMicrotask(()=> { this.jrefresh(false); });
        }
    }
    connectedCallback() {
        super.connectedCallback();
        this.restartUpdateTimer();
    }
    disconnectedCallback() {
        super.disconnectedCallback();
        clearInterval(this._updateTimer);
        this._updateTimer = null;
        if (this._updateCooldown.timer) {
            window.clearTimeout(this._updateCooldown.timer);
            this._updateCooldown.timer = undefined;
        }
    }
    setConfig(config) {
        this._config = config;
    }
    // Slider changed value
    slideCh(ev) {
        let val = this.shadowRoot.querySelector("ha-slider").value;
        if (val >= 0 && val < this._sliderValArr.length) {
            this._sliderVal = val;
        } else {
            console.error('slider value out of bounds:', val);
        }
        this.restartUpdateTimer();
        this.jrefresh(true);
    }
    restartUpdateTimer() {
        if (this._updateTimer) {
            clearInterval(this._updateTimer);
        }
        let intMs = this._sliderValArr[this._sliderVal].secs * 1000 / this._updateIntervalFactor;
        // The purpose of this interval timer is to remove from display old alerts that fall outside
        // the displayed time window.
        this._updateTimer = setInterval(()=> { this.jrefresh(true); }, intMs);
    }
    // Ack all button was pressed
    async _ackAll(ev) {
        this._ackAllInProgress = true;
        let abutton = ev.target;
        let outerThis = this;
        try {
            await this._hass.callWS({
                type: "execute_script",
                sequence: [ {
                    service: 'alert2.ack_all',
                    data: {},
                }],
            });
        } catch (err) {
            this._ackAllInProgress = false;
            abutton.actionError();
            showToast(this, "error: " + err.message);
            return;
        }
        this._ackAllInProgress = false;
        abutton.actionSuccess();
    }
    async _toggleShowVersion(ev) {
        this._showVersion = ! this._showVersion;
    }
    render() {
        if (!this._cardHelpers || !this._hass) {
            return html`<div>Loading.. waiting for hass + card helpers to load</div>`;
        }

        const outerThis = this;
        let entListHtml;
        if (this._sortedDispInfos.length == 0) {
            entListHtml = html`<div id="jempt">No alerts active in the past ${this._sliderValArr[this._sliderVal].str}. No alerts snoozed or disabled.</div>`;
        } else {
            // entitiesConf can be just a list of string entity names, or it can be a list of configs. maybe both.
            let entitiesConf = this._sortedDispInfos.map(obj=>({ entity: obj.entityName }));
            for (let aconf of entitiesConf) {
                if (aconf.entity.startsWith('alert2.')) {
                    // 'custom:' gets stripped off in src/panels/lovelace/create-element/create-element-base.ts
                    aconf.type = 'custom:hui-alert2-entity-row';
                    // fire-dom-event causes ll-custom event to fire, if we're using hui-generic-entity-row, which we're not anymore.
                    // This should have no effect.
                    // aconf.tap_action = { action: "fire-dom-event" };
                }
            }

            let ackedIdx = this._sortedDispInfos.findIndex(el => el.isAcked);
            if (ackedIdx == 0) {
                // Only acked alerts
                //entListHtml = html`<div id="nounacks">No unacked alerts that haven't been snoozed or disabled</div>
                //                   ${entitiesConf.map((entityConf) => this.renderEntity(entityConf) )}`;
                entListHtml = html`<div id="ackbar">---- Acked, snoozed or disabled ---</div>
                                   ${entitiesConf.map((entityConf) => this.renderEntity(entityConf) )}`;
            } else if (ackedIdx == -1) {
                // No acked alerts
                entListHtml = html`${entitiesConf.map((entityConf) => this.renderEntity(entityConf) )}`;
            } else {
                // some acked and unacked
                entListHtml = html`${entitiesConf.slice(0, ackedIdx).map((entityConf) => this.renderEntity(entityConf) )}
                                   <div id="ackbar">---- Acked, snoozed or disabled ---</div>
                                   ${entitiesConf.slice(ackedIdx).map((entityConf) => this.renderEntity(entityConf) )}`;
            }
        }
        let manifestVersion = 'unknown';
        let mObj = this._hass.states['binary_sensor.alert2_ha_startup_done'];
        if (Object.hasOwn(mObj.attributes, 'manifest_version')) {
            manifestVersion = mObj.attributes.manifest_version;
        }
        let versionHtml = this._showVersion ? html`<table class="tversions" cellspacing=0>
             <tr><td>Alert2 UI<td>${VERSION}</tr><tr><td>Alert2<td>v${manifestVersion}</tr></table>` : html``;
        let foo = html`<ha-card>
            <h1 class="card-header"><div class="name" @click=${this._toggleShowVersion}>Alerts</div>${versionHtml}</h1>
            <div class="card-content">
              <div style="display:flex; align-items: center; margin-bottom: 1em;">
                  <ha-slider .min=${0} .max=${this._sliderValArr.length-1} .step=${1} .value=${this._sliderVal} snaps ignore-bar-touch
                     @change=${this.slideCh}
                  ></ha-slider>
                  <span id="slideValue">Last ${this._sliderValArr[this._sliderVal].str}</span>
                <div style="flex-grow: 1;"></div>
                <ha-progress-button
                    .progress=${this._ackAllInProgress}
                    @click=${this._ackAll}
                    >Ack all</ha-progress-button>
              </div>
              ${entListHtml}
            </div>
          </ha-card>`;
        return foo;
    }
    renderEntity(entityConf) {
        let entityName = entityConf.entity;
        const element = this._cardHelpers.createRowElement(entityConf);
        element.hass = this._hass;
        let outerThis = this;
        // hui-generic-entity-row calls handleAction on events, including clicks.
        // we set the action to take on 'tap' to be 'fire-dom-event', which generates a 'll-custom' event
        // NOTE - the hui- code gobbles up the click event and on chrome-mobile seems to gobble up clicks on an 'ack' button as well :(,
        // and further, the ll-custom event does not include information on which element was originally clicked on. :(
        //
        //element.addEventListener('ll-custom', (ev)=>outerThis._alertClick(ev, entityName));
        if (entityConf.entity.startsWith('alert.')) {
            // it already has a built-in more-info click listener
        } else {
            element.addEventListener('click', (ev)=>outerThis._alertClick(ev, element, entityName));
        }
        //element.addEventListener('click', this.anev2);
        //console.log('foo2', element);
        //console.log('ick', element.shadowRoot.querySelector('hui-generic-entity-row'));
        //return html`<div class="jEvWrapper" @click=${this.anev1} >${element}</div>`;
        return html`<div class="jEvWrapper">${element}</div>`;
    }
    _alertClick(ev, element, entityName) {
        let stateObj = this._hass.states[entityName];
        let friendlyName = stateObj.attributes.friendly_name2;
        let title = '';
        if (friendlyName) {
            title += `"${friendlyName}" (entity ${entityName})`;
        } else {
            title += entityName;
        }
        //let innerHtml = html`<more-info-alert2  dialogInitialFocus .entityId=${entityName} .hass=${this.hass} >
        //                     </more-info-alert2>`;
        let innerElem = document.createElement('more-info-alert2');
        innerElem.entityId = entityName;
        innerElem.setAttribute('dialogInitialFocus', '');
        innerElem.hass = this._hass;
        jCreateDialog(element, title, innerElem);
        if (0) {
            jFireEvent(element, "show-dialog", {
                dialogTag: "more-info-alert2-container",
                dialogImport: () => new Promise((resolve)=> { resolve(); }),
                dialogParams: {
                    entityName: entityName,
                },
                addHistory: true
            });
        }
        return true;
    }
    static styles = css`
      .card-header {
        display: flex;
        justify-content: space-between;
      }
      .card-header .name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      div#jempt {
        margin: 0px 18px 18px 18px;
      }
      .icon {
        padding: 0px 18px 0px 8px;
      }
      .info {
        overflow: visible;
      }
      .header {
        border-top-left-radius: var(--ha-card-border-radius, 12px);
        border-top-right-radius: var(--ha-card-border-radius, 12px);
        margin-bottom: 16px;
        overflow: hidden;
      }
      .footer {
        border-bottom-left-radius: var(--ha-card-border-radius, 12px);
        border-bottom-right-radius: var(--ha-card-border-radius, 12px);
        margin-top: -16px;
        overflow: hidden;
      }
      .jEvWrapper:not(:last-child) {
          margin-bottom: 1em;
      }
      .tversions {
        font-size: 1rem;
        user-select: text;
        line-height: 1.2em;
        height: 0;  /* necessary, no idea why.  could also be max-content */
      }
      .tversions td {
          padding: 0px;
      }
      .tversions td:first-child {
          padding-right: 0.7em;
      }
      div#ackbar {
          margin-bottom: 1em;
          text-align: center;
          font-size: 0.9em;
      }
    `;

    // Returns true if changed list of entities.
    jrefresh(forceBigRefresh) {
        //console.log('doing jrefresh', forceBigRefresh);
        if (!this._hass) {
            console.log('  skipping jrefresh cuz no hass');
            return false;
        }
        
        if (forceBigRefresh) {
            // doing periodic check for aged out entities, gotta take slow path
        } else {
            // called as result of calls to set hass.
            // So just gotta check if states has changed
            let existingCount = 0;
            for (let entityName in this._hass.states) {
                if (entityName.startsWith('alert.') ||
                    entityName.startsWith('alert2.')) {
                    if (this._alert2StatesMap.has(entityName)) {
                        existingCount += 1;
                        if (this._hass.states[entityName] !== this._alert2StatesMap.get(entityName)) {
                            //console.log('  will force cuz', entityName);
                            forceBigRefresh = true;
                        }
                    } else {
                        // New entity appeared
                        forceBigRefresh = true;
                    }
                }
            }
            if (this._alert2StatesMap.size > existingCount) {
                // Some entity has been deleted
                forceBigRefresh = true;
            }
        }
        if (!forceBigRefresh) {
            return;
        }

        this._alert2StatesMap.clear();
        for (let entityName in this._hass.states) {
            if (entityName.startsWith('alert.') ||
                entityName.startsWith('alert2.')) {
                this._alert2StatesMap.set(entityName, this._hass.states[entityName]);
            }
        }
        
        const intervalSecs = this._sliderValArr[this._sliderVal].secs;
        //console.log('intervalSecs as hours', intervalSecs / 60 / 60);
        const nowMs = Date.now();
        const intervalStartMs = nowMs - (intervalSecs*1000);
        let entDispInfos = [];
        let unsortedEnts = [];
        for (let entityName in this._hass.states) {
            let isAcked = false;
            let isOn = false;
            let testMs = 0; // 1970
            const ent = this._hass.states[entityName];
            if (entityName.startsWith('alert.')) {
                if (ent.state == 'on') { // on means unacked
                    let lastChangeMs = Date.parse(ent.last_changed);
                    isOn = true;
                    testMs =  lastChangeMs;
                    entDispInfos.push({ isOn:isOn, isAcked:isAcked, testMs:testMs, entityName:entityName } );
                } // else is off, which means acked, or is idle which means is off.
            } else if (entityName.startsWith('alert2.')) {
                let lastAckMs = 0;
                if (ent.attributes['last_ack_time']) {
                    lastAckMs = Date.parse(ent.attributes['last_ack_time']);
                }
                if ('last_on_time' in ent.attributes) {
                    // Is a condition alert
                    let lastOnMs = 0;
                    if (ent.attributes['last_on_time']) {
                        lastOnMs = Date.parse(ent.attributes['last_on_time']);
                        isAcked = lastAckMs > lastOnMs;
                    }
                    if (ent.state == 'on') {
                        isOn = true;
                        testMs = Date.parse(ent.attributes['last_on_time']);
                    } else if (ent.state == 'off') {
                        if (ent.attributes['last_off_time']) {
                            testMs = Date.parse(ent.attributes['last_off_time']);
                        } // else never fired
                    } else {
                        console.error('Entity state is not on/off', ent.state, entityName);
                    }
                } else {
                    // Edge triggered alert
                    if (ent.state) {
                        let lastFireMs = Date.parse(ent.state);
                        isAcked = lastAckMs > lastFireMs;
                        testMs = lastFireMs;
                    } // else alert has never fired
                }
                if (isNaN(testMs)) {
                    console.error('Entity ', ent.entity_id, ent.state, 'parse error lastFireMs', testMs);
                    continue;
                }
                const not_enabled = (ent.attributes.notification_control &&
                                     (ent.attributes.notification_control != NOTIFICATIONS_ENABLED));
                if (not_enabled) {
                    isAcked = true;  // treat snoozed or disabled alerts as already acked
                }
                //console.log('considering ', entityName, testMs - intervalStartMs);
                if (isOn || intervalStartMs < testMs || not_enabled) {
                    entDispInfos.push({ isOn:isOn, isAcked:isAcked, testMs:testMs, entityName:entityName } );
                }
            }
        }

        // Now sort the entities. return negative if a should come before b
        let sortFunc = function(a, b) {
            if (a.isAcked != b.isAcked) {
                return a.isAcked ? 1 : -1;
            } else if (a.isOn != b.isOn) {
                return a.isOn ? -1 : 1;
            } else {
                return b.testMs - a.testMs;
            }
        }
        let doUpdate = false;
        let sortedDispInfos = entDispInfos.sort(sortFunc);
        if (sortedDispInfos.length !== this._sortedDispInfos.length) {
            doUpdate = true;
        } else {
            for (let idx = 0 ; idx < sortedDispInfos.length; idx ++) {
                let olde = this._sortedDispInfos[idx];
                let newe = sortedDispInfos[idx];
                if (newe.entityName !== olde.entityName) {
                    doUpdate = true;
                    break;
                }
                if (newe.isOn != olde.isOn ||
                    newe.isAcked != olde.isAcked ||
                    newe.testMs != newe.testMs) {
                    doUpdate = true;
                    break;
                }
            }
        }
        if (doUpdate) {
            // Will trigger rerender
            this._sortedDispInfos = sortedDispInfos;
        }
        return doUpdate;
    }
}

// Similar to src/panels/lovelace/entity-rows/hui-climate-entity-row.ts
// implements LovelaceRow
class Alert2EntityRow extends LitElement  {
    static properties = {
        _config: {state: true},
    }
    set hass(nh) {
        this._hass = nh;
        if (this.shadowRoot && this._hass && this._config) {
            this.shadowRoot.querySelectorAll("ha-alert2-state").forEach((element) => {
                const stateObj = this._hass.states[this._config.entity];
                element.stateObj = stateObj;
            });
        }
    }
    constructor() {
        super();
        this._hass = null;
        this._config = null;
        this._stateEl = null;
    }
    setConfig(config) {
        if (!config || !config.entity) {
            throw new Error("Entity must be specified");
        }
        this._config = config;
    }
    _rowClick(ev) {
        console.log('_rowClick', ev);
        return true;
    }
    render() {
        if (!this._hass || !this._config) {
            console.warn('foo, not ready to render');
            return nothing;
        }
        const stateObj = this._hass.states[this._config.entity];
        if (!stateObj) {
            return html`
        <hui-warning>
          ${createEntityNotFoundWarning(this._hass, this._config.entity)}
        </hui-warning>
      `;
        }
        //let entHtml = '';
        //console.log('foo', this._config);
        const friendlyName = this._hass.states[this._config.entity].attributes.friendly_name2;
        //console.log('foo3', this._hass.states[this._config.entity]);
        //console.log('foo3b', this._hass.states[this._config.entity].attributes);
        //console.log('foo2b', friendlyName);
        let nameToUse = friendlyName ? friendlyName : stateObj.entity_id;
        const entHtml = nameToUse.split('_').map((x,idx,arr)=>(idx < arr.length-1)? html`${x}_<wbr/>` : html`${x}`);
        
        // This is essentially the guts of hui-generic-entity-row, except it does not swallow click events, like hui-generic-entity-row does (and converts it to ll-custom).  That means we can react to a click on a 'Ack' button in a row entity.
//       <div class="awrapper">
  //    </div>
        return html`
         <div class="outhead">
            <state-badge class="pointer" .hass=${this._hass} .stateObj=${stateObj} @click=${this._rowClick} tabindex="0"></state-badge>
            <div class="info pointer text-content" title=${stateObj.entity_id} @click=${this._rowClick}  >${entHtml}</div>
         </div>
         <ha-alert2-state .hass=${this._hass} .stateObj=${stateObj} class="text-content value pointer astate"  @click=${this._rowClick} >
         </ha-alert2-state>
`;
    }

    static styles = css`
      :host {
        display: flex;
        flex-flow: row wrap;
        align-items: center;
        /*justify-content: space-between;*//* not needed now that we use margin-left: auto */
      }
      .outhead, .astate {
       /* note max-content I think ignores flex basis.
        * so setting flex-basis in children may make things not fit. */
        max-width: max-content; /* flex: once heading has enough room, give rest to state */
      }
      .outhead {
        display: flex;
        align-items: center;
        flex: 1 1 10em;
        min-width: 7em; 
      }
      .astate {
        margin-left: auto; /* so if it wraps it is right justified */
        flex: 0 0 auto;
      }
      .awrapper {
        display: flex;
        align-items: center;
        flex-direction: row;
     }
      .info {
        margin-left: 16px;
        margin-right: 8px;
        line-height: 1.1em;
        flex: 1 1 auto;
      }
      .info,
      .info > * {
        /*white-space: nowrap;*/
        overflow-wrap: anywhere;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      state-badge {
        /* can't use flex basis to set width here, cuz it messes up the max-content directive in parent */
        flex: 0 0 auto; 
        line-height: normal;
        height: auto;
      }
      .pointer {
        cursor: pointer;
      }
    `;
}

function formatLogDate(idate) {
    function z2(num) { return ('0'+num).slice(-2); }
    function z3(num) { return ('00'+num).slice(-3); }
    let adate = new Date(Date.parse(idate));
    // e.g., 2024/12/20 13:05:15.123  (local time)
    return `${adate.getFullYear()}/${z2(adate.getMonth())}/${z2(adate.getDate())} ${z2(adate.getHours())}:${z2(adate.getMinutes())}:${z2(adate.getSeconds())}.${z3(adate.getMilliseconds())}`
}

function agoStr(adate, longnames) {
    const secondsAgo = (new Date() - adate) / 1000.0;
    let astr;
    let intervalSecs;
    if (secondsAgo < 2*60) { astr = `${Math.round(secondsAgo)}${longnames?" seconds":" s"}`; intervalSecs = 1; }
    else if (secondsAgo < 2*60*60) { astr = `${Math.round(secondsAgo/60)}${longnames?" minutes":" min"}`; intervalSecs = 60; }
    else if (secondsAgo < 2*24*60*60) { astr = `${Math.round(secondsAgo/(60*60))}${longnames?" hours":" h"}`; intervalSecs = 60*60; }
    else { astr = `${Math.round(secondsAgo/(24*60*60))}${longnames?" days":" d"}`; intervalSecs = 24*60*60; }
    return { str:`${astr} ago`, secs:intervalSecs };
}

// Similar to ha-relative-time, except adjusts the update interval corresponding to the displayed units.
class RelativeTime extends LitElement {
    static properties = {
        timestamp: {state: true},
        useLongnames: {state: true},
    }
    constructor() {
        super();
        this.timestamp = null;
        this._updateTimer = null;
    }
    connectedCallback() {
        super.connectedCallback();
        this.requestUpdate();
    }
    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._updateTimer) {
            clearTimeout(this._updateTimer);
            this._updateTimer = null;
        }
    }
    render() {
        if (this._updateTimer) {
            clearTimeout(this._updateTimer);
            this._updateTimer = null;
        }
        const info = agoStr(this.timestamp, this.useLongnames);
        this._updateTimer = setTimeout(()=>{this.requestUpdate();}, info.secs*1000);
        return html`<span>${info.str}</span>`;
    }
}

// Element to render the state of an alert
class HaAlert2State extends LitElement {
    static properties = {
        _ackInProgress: {state: true},
    }
    constructor() {
        super();
        this._stateObj = null;
        this._ackInProgress = false;
        this._hass = null;
    }
    set hass(ao) {
        this._hass = ao;
    }
    set stateObj(ao) {
        let old = this._stateObj;
        this._stateObj = ao;
        if (old != ao) {
            this.requestUpdate();
        }
    }
    async _jack(ev) {
        await this.ackInternal(ev, true);
    }
    async _junack(ev) {
        await this.ackInternal(ev, false);
    }
    async ackInternal(ev, isAck) {
        let op = isAck ? 'ack' : 'unack';
        console.log(`${op} clicked`, this._stateObj.entity_id);
        this._ackInProgress = true;
        let abutton = ev.target;
        ev.stopPropagation();
        if (1) {
            try {
                await this._hass.callWS({
                    type: "execute_script",
                    sequence: [ {
                        service: isAck ? 'alert2.ack' : 'alert2.unack',
                        data: {},
                        target: { entity_id: this._stateObj.entity_id }
                    }],
                });
            } catch (err) {
                this._ackInProgress = false;
                abutton.actionError();
                showToast(this, "error: " + err.message);
                return;
            }
            this._ackInProgress = false;
            abutton.actionSuccess();
        }
    }
    render() {
        if (!this._stateObj) {
            return html`<div>loading...</div>`;
        }
        const ent = this._stateObj;
        let msg;
        let last_ack_time = null;
        if (ent.attributes['last_ack_time']) {
            last_ack_time = Date.parse(ent.attributes['last_ack_time']);
        }
        let last_on_time = null;
        if (ent.attributes['last_on_time']) {
            last_on_time = Date.parse(ent.attributes['last_on_time']);
        }

        let last_fired_time = null;
        if (last_on_time) {
            last_fired_time = last_on_time;
            if (ent.state == 'on') {
                //msg = 'on';
                const last_on_time = Date.parse(ent.attributes['last_on_time']);
                msg = html`on<j-relative-time .timestamp=${last_on_time} .useLongnames=${false} style="margin-left:0.5em;"></j-relative-time>`;
            } else if (ent.state == 'off') {
                const last_off_time = Date.parse(ent.attributes['last_off_time']);
                msg = html`off<j-relative-time .timestamp=${last_off_time} .useLongnames=${false} style="margin-left:0.5em;"></j-relative-time>`;
            } // else - should never happen, was checked when populated _shownEntities list.
        } else {
            last_fired_time = Date.parse(ent.state);
            msg = html`<j-relative-time .timestamp=${last_fired_time} .useLongnames=${false}></j-relative-time>`;
        }
        let ackButton = ''
        if (last_ack_time && last_ack_time > last_fired_time) {
            ackButton = html`<ha-progress-button
                  .progress=${this._ackInProgress} class="unack"
                  @click=${this._junack}>Unack</ha-progress-button>
                 `;
        } else {
            ackButton = html`<ha-progress-button
                  .progress=${this._ackInProgress}
                  @click=${this._jack}>Ack</ha-progress-button>
                 `;
        }
        let snoozeBadge = '';
        if (ent.attributes.notification_control == NOTIFICATIONS_ENABLED) { }
        else if (ent.attributes.notification_control == NOTIFICATIONS_DISABLED) {
            snoozeBadge = html`<div class="badge">Disabled</div>`;
        } else if (ent.attributes.notification_control) {
            // snoozed. val is date snoozed til
            snoozeBadge = html`<div class="badge">Snoozed</div>`;
        }
        let numSince = ent.attributes.fires_since_last_notify;
        if (ent.state == 'on' && numSince > 0) {
            // If alert is on and fires_since_last_notify > 0, then the firing must include
            // the one that turned this on. So subtract it from the count.
            numSince -= 1;
        }
        const extraFiresBadge = (numSince == 0) ? '' : html`<div style="display: flex; align-items:center; margin-left:0.3em;">+${numSince}x</div>`;
        
        return html`<div class="onerow">${snoozeBadge}${ackButton}</div>
                    <div class="onerow"><div class="curr">${msg}</div>${extraFiresBadge}</div>`;
    }
    static styles = css`
      .unack {
          opacity: 0.6;
      }
      .onerow {
          display: flex;
          flex-flow: row;
          align-items: center;
      }
      ha-progress-button {
          display: flex;
          height: 1em;
          align-items: center;
      }
      .badge {
          border-radius: 10%;
          border: 0.2em solid var(--label-badge-text-color, rgb(76, 76, 76));
          color: var(--label-badge-text-color, rgb(76, 76, 76));
          padding: 0.1em 0.3em;
          /* margin-right: 1em; */
          font-size: 0.9em;
          opacity: 0.5;
          height: fit-content;
      }
      .noborder {
          border: none;
      }
      :host {
        display: flex;
        flex-direction: row;
        /* flex-wrap: wrap;*/
        justify-content: right;
        white-space: nowrap;
        align-items: center;
      }
      .curr {
        display: flex;
        align-items: center;
      }
      .target {
        color: var(--primary-text-color);
      }

      .current {
        color: var(--secondary-text-color);
      }

      .state-label {
        font-weight: bold;
        text-transform: capitalize;
      }

      .unit {
        display: inline-block;
        direction: ltr;
      }
    `;
}

class StateCardAlert2 extends LitElement {
    static properties = {
        hass: {attribute: false},
        stateObj: {attribute: false},
        inDialog: { }
    }
    static styles = css`
        :host {
          @apply --paper-font-body1;
          line-height: 1.5;
        }
        .layout.horizontal {
            display: flex;
            flex-direction: row;
            justify-content: space-between;
        }
        ha-alert2-state {
          margin-left: 16px;
          text-align: right;
        }
     `;
  render() {
    return html`
      <style include="iron-flex iron-flex-alignment"></style>
      <div class="horizontal justified layout">
        <state-info
          .hass=${this.hass}
          .stateObj=${this.stateObj}
          ?inDialog=${this.inDialog}
        ></state-info>
        <ha-alert2-state
          .hass=${this.hass}
          .stateObj=${this.stateObj}
        ></ha-alert2-state>
      </div>
    `;
  }
}

function strIsValidNumber(astr) {
    if (typeof(astr) !== 'string') { return false; }
    let bstr = astr.trim();
    let val = Number(bstr);
    if (bstr.length > 0 && !isNaN(val) && val >= 0) {
        return val;
    } else { return null; }
}

// Add this attribute to alert entity attributes:
// 'custom_ui_more_info' : 'more-info-alert2', # name of UI element that must be defined
//
// Similar to ha-more-info-info from src/dialogs/more-info/ha-more-info-info.ts
class MoreInfoAlert2 extends LitElement {
    static properties = {
        hass: { attribute: false },
        //stateObj: { },
        entityId: { attribute: false },
        _requestInProgress: {state: true},
        _ackInProgress: {state: true},
        _currValue: {state: true},
        _historyArr: {state: true},
    }
    // I don't think anything sets hass on MoreInfoAlert2 and so this code will never run after init
    shouldUpdate(changedProps) {
        //console.log('MoreInfoAlert2  shouldUpdate: ', changedProps);
        if (changedProps.has('hass')) {
            const oldHass = changedProps.get("hass");
            if (!oldHass) { return true; }
            const newHass = this.hass;
            const oldState = oldHass.states[this.entityId];
            const newState = newHass.states[this.entityId];
            let changed = oldState !== newState;
            if (changed) {
                //console.log('    MoreInfoAlert2 state changed: ', oldState, newState);
            }
            return changed;
        }
        return true;
    }
    constructor() {
        super();
        this._requestInProgress = false;
        this._ackInProgress = false;
        this._currValue = NOTIFICATIONS_ENABLED;
        this.textEl = null;
        this._historyArr = null;
        this._historyStartDate = null;
        this._historyEndDate = null;
        this._fetchPrevInProgress = false;
        this._fetchCurrInProgress = false;
        // no shadowRoot yet.
    }
    connectedCallback() {
        super.connectedCallback();
        // no shadowRoot yet.
    }
    firstUpdated() {
        super.firstUpdated();
        // see https://lit.dev/docs/v1/components/lifecycle/#firstupdated
        // could use connectedCallback to do this earlier
        let stateObj = this.hass.states[this.entityId];
        this._currValue = stateObj.attributes.notification_control;
        let s1 = this.shadowRoot.querySelector('ha-formfield#for-snooze ha-textfield');
        this.textEl = s1;
        this.textEl.validityTransform = (newValue, nativeValidity) => {
            let isvalid = strIsValidNumber(newValue) != null;
            return { valid: isvalid };
        }
        this.fetchCurr();
        customElements.whenDefined('state-card-alert2').then(()=>{
            this.requestUpdate();
        });
    }
    showDialog(dialogParams) {
        console.log('MoreInfoAlert2 showDialog called', dialogParams);
    }
    fetchPrev() {
        const msAgo = 24*60*60*1000.0;
        if (!this._historyStartDate) {
            this.fetchCurr();
            return;
        }
        this._historyEndDate = this._historyStartDate;
        this._historyStartDate = new Date(this._historyStartDate.getTime() - msAgo);
        this._fetchPrevInProgress = true;
        this.getHistory();
    }
    fetchCurr() {
        const msAgo = 24*60*60*1000.0;
        this._historyStartDate = new Date((new Date()).getTime() - msAgo);
        this._historyEndDate = null;
        this._fetchCurrInProgress = true;
        this.getHistory();
    }
    getHistory() {
        console.log('will getHistory from', this._historyStartDate);
        let stateObj = this.hass.states[this.entityId];
        let historyUrl = `history/period/${this._historyStartDate.toISOString()}?filter_entity_id=${stateObj.entity_id}`;
        if (this._historyEndDate) {
            historyUrl += `&end_time=${this._historyEndDate.toISOString()}`;
        }
        const outerThis = this;
        const isAlert = 'last_on_time' in stateObj.attributes;
        const maxCount = 20;
        this.hass.callApi('GET', historyUrl).then(function(rez) {
            console.log('got history state', rez);
            outerThis._fetchCurrInProgress = false;
            outerThis._fetchPrevInProgress = false;
            if (Array.isArray(rez) && Array.isArray(rez[0])) {
                let rezArr = rez[0].reverse();
                if (rezArr.length == 0) {
                    outerThis._historyArr = [];
                    return;
                }
                // Iterate from newest to oldest.
                let newArr = [ rezArr[0] ];
                let tstate = rezArr[0].state;
                if (!tstate) {
                    outerThis._historyArr = [];
                    return;
                }
                for (let idx = 1 ; idx < rezArr.length ; idx++) {
                    if (rezArr[idx].state && rezArr[idx].state != tstate) {
                        tstate = rezArr[idx].tstate;
                        newArr.push(rezArr[idx]);
                    }
                }
                if (newArr.length >= maxCount) {
                    let oldestEl = newArr[maxCount-1];
                    let oldestDate = Date.parse(oldestEl.last_updated);
                    if (oldestDate == NaN) {
                        console.error('Alert2: Unable to parse last_updated', oldestEl.last_updated);
                    } else {
                        newArr = newArr.slice(0, maxCount);
                        outerThis._historyStartDate = new Date(oldestDate);
                    }
                }
                outerThis._historyArr = newArr;
            }
        }).catch((err)=> { console.error('hass call to get alert history failed: ', err); });
    }
    
    render() {
        if (!this.hass) {
            return "";
        }
        let stateObj = this.hass.states[this.entityId];
        let stateValue = stateObj.attributes.notification_control;
        let notification_status;
        if (stateValue == null) {
            notification_status = "unknown";
        } else if (stateValue == NOTIFICATIONS_ENABLED) {
            notification_status = "enabled";
        } else if (stateValue == NOTIFICATIONS_DISABLED) {
            notification_status = "disabled";
        } else {
            notification_status = "snoozed until " + formatLogDate(stateValue);
        }

        let is_snoozed = false;
        if (this._currValue == NOTIFICATIONS_ENABLED ||
            this._currValue == NOTIFICATIONS_DISABLED) {
        } else {
            is_snoozed = true;
        }
        const entName = stateObj.entity_id;
        const isAlert = 'last_on_time' in stateObj.attributes;
        let isAlertOn = false;
        let onBadge = ''
        if (isAlert) {
            isAlertOn = stateObj.state == 'on';
            onBadge = isAlertOn ? "on" : "off";
        }
        let historyHtml = html`Fetching history...`;
        if (this._historyArr !== null) {
            if (this._historyArr.length == 0) {
                historyHtml = html`No history exists`;
            } else {
                const thass = this.hass;
                function rHist(elem) {
                    const onoff = isAlert ? html`<td>${elem.state}</td>` : '';
                    const extraTxt = (isAlert && elem.state == 'off') ? '' : elem.attributes.last_fired_message;
                    let eventTime = elem.attributes.last_fired_time;
                    if (isAlert) {
                        eventTime = (elem.state == 'on') ? elem.attributes.last_on_time : elem.attributes.last_off_time;
                    }
                    const firedTime = eventTime ?
                          html`<j-relative-time
                                   .timestamp=${Date.parse(eventTime)} .useLongnames=${true}></j-relative-time>` : 'unknown';
                    const absTime = eventTime ?
                          html`<span style="font-size:0.8em;">${formatLogDate(eventTime)}</span>` : 'unknown';
                    return html`
                <tr class="eventrow">
                <td class="eventtime">${firedTime}<br/>${absTime}</td>
                ${onoff}
                <td>${extraTxt}</td>
                </tr>
                    `;
                }
                historyHtml = html`<table>
                    <tr>
                      <th>Event time</th>
                      ${ isAlert ? html`<th style="padding-left: 1em;">On/Off</th>` : '' }
                      <th style="padding-left: 1em;">Message</th>
                    </tr>
                    ${this._historyArr.map((elem) => rHist(elem) )}</table>`;
            }
        }
        // This is written so that it will stay live and update notification control status,
        // but will not change the notification control settings themselves,
        // so you don't get overrulled why trying to change settings.  This is done by
        // having this._currValue only change due to user input, not changes to hass.
        return html`
         <div class="container" >
            <state-card-content
              in-dialog
              .stateObj=${stateObj}
              .hass=${this.hass}
            ></state-card-content>
            <div id="previousFirings" style="margin-top: 1em;">
               <div style="display: flex; margin-top: 2em; margin-bottom: 1em; align-items: center;">
                  <div class="title">Previous Firings</div>
                  <div style="flex: 1 1 0; max-width: 10em;"></div>
                  <ha-progress-button
                    .progress=${this._fetchPrevInProgress}
                    @click=${this.fetchPrev}
                  >Prev</ha-progress-button>
                  <ha-progress-button
                    .progress=${this._fetchCurrInProgress}
                    @click=${this.fetchCurr}
                  >Reset</ha-progress-button>
               </div>
               <div class="alist">
                  ${historyHtml}
               </div>
            </div>
            <div class="title" style="margin-top: 1em;">Notifications</div>
            <div style="margin-bottom: 0.3em;">Status: ${notification_status}</div>
            <div><ha-formfield .label=${"Enable"}>
                  <ha-radio
                      .checked=${NOTIFICATIONS_ENABLED == this._currValue}
                      .value=${NOTIFICATIONS_ENABLED}
                      .disabled=${false}
                      @change=${this._valueChanged}
                      ></ha-radio></ha-formfield></div>
            <div><ha-formfield .label=${"Disable"}><ha-radio
                  .checked=${NOTIFICATIONS_DISABLED == this._currValue}
                  .value=${NOTIFICATIONS_DISABLED}
                  .disabled=${false}
                  @change=${this._valueChanged}
                  ></ha-radio></ha-formfield></div>
            <div style="margin-bottom:1em;"><ha-formfield id="for-snooze">
                  <!-- if change structure of HTML here, update _aclick() -->
                  <ha-radio
                      id="rad1"
                      .checked=${is_snoozed}
                      .value=${"snooze"}
                      .disabled=${false}
                      @change=${this._valueChanged}
                      ></ha-radio>
                  <div style="display:inline-block;" id="slabel" @click=${this._aclick}>Snooze for 
                      <ha-textfield
                          .placeholder=${"1.234"}
                          .min=${0}
                          .disabled=${false}
                          .required=${is_snoozed}
                          .suffix=${"hours"}
                         type="number"
                         inputMode="decimal"
                          autoValidate
                          ?no-spinner=false
                          @input=${this._handleInputChange}
                          ></ha-textfield>
                  </div>
              </ha-formfield>
            </div>
            <ha-progress-button
                  .progress=${this._requestInProgress}
                  @click=${this._jupdate}>Update</ha-progress-button>
            <br/><br/>
            <ha-attributes
                .hass=${this.hass}
                .stateObj=${stateObj}
                ></ha-attributes>
         </div>`;
    }
    //let par = customElements.get("ha-more-info-info").styles;
    static styles = css`
    table {
      /*border-collapse: separate;*/
      /*border-spacing: 0 1em;*/
    }
    td {
      padding: 0 15px 15px 15px;
      vertical-align: top;
    }
    td.eventtime {
       word-break: break-all;
       min-width: 4em;
    }
    div#slabel {
      pointer: default;
    }
    ha-textfield {
      margin-left: 1em;
      margin-right: 1em;
    }
    .container {
        /* padding: 24px; */
        margin-bottom: 1em;
     }
        .title {
          font-family: var(--paper-font-title_-_font-family);
          -webkit-font-smoothing: var(
            --paper-font-title_-_-webkit-font-smoothing
          );
          font-size: var(--paper-font-subhead_-_font-size);
          font-weight: var(--paper-font-title_-_font-weight);
          letter-spacing: var(--paper-font-title_-_letter-spacing);
          line-height: var(--paper-font-title_-_line-height);
        }
      `;

    _valueChanged(ev) {
        let value = ev.detail?.value || ev.target.value;
        if (value == "snooze") {
            value = this.textEl.value;
        }
        this._currValue = value;
    }
    _handleInputChange(ev) {
        ev.stopPropagation();
        const value = ev.target.value;
        this._currValue = value;
    }
    async _jupdate(ev) {
        console.log('submit clicked', this._currValue, this);
        this._requestInProgress = true;
        let abutton = ev.target;
        let data = { };
        if (this._currValue == NOTIFICATIONS_ENABLED) {
            data.enable = 'on';
        } else if (this._currValue == NOTIFICATIONS_DISABLED) {
            data.enable = 'off';
        } else {
            let val = strIsValidNumber(this._currValue);
            if (val == null) {
                this._requestInProgress = false;
                abutton.actionError();
                console.error('bad value', this._currValue);
                showToast(this, "Non-positive numeric value: " + this._currValue);
                return;
            }
            data.enable = 'on';
            let hours = val;
            var newDate = new Date((new Date()).getTime() + hours*60*60*1000);
            data.snooze_until = newDate;
        }
        let stateObj = this.hass.states[this.entityId];
        try {
            await this.hass.callWS({
                type: "execute_script",
                sequence: [ {
                    service: 'alert2.notification_control',
                    data: data,
                    target: { entity_id: stateObj.entity_id }
                }],
            });
        } catch (err) {
            this._requestInProgress = false;
            abutton.actionError();
            showToast(this, "error: " + err.message);
            return;
        }
        this._requestInProgress = false;
        abutton.actionSuccess();
        this.requestUpdate();
    }
    async _jack(ev) {
        this._ackInProgress = true;
        let abutton = ev.target;
        ev.stopPropagation();
        let stateObj = this.hass.states[this.entityId];
        try {
            await this.hass.callWS({
                type: "execute_script",
                sequence: [ {
                    service: 'alert2.ack',
                    data: {},
                    target: { entity_id: stateObj.entity_id }
                }],
            });
        } catch (err) {
            this._ackInProgress = false;
            abutton.actionError();
            showToast(this, "error: " + err.message);
            return;
        }
        this._ackInProgress = false;
        abutton.actionSuccess();
    }
    _aclick(ev) {
        let formEl = ev.target.parentElement;
        let count = 2;
        while (formEl.nodeName !== "HA-FORMFIELD" && (count-- > 0)) {
            formEl = formEl.parentElement;
        }
        if (formEl.nodeName !== "HA-FORMFIELD") {
            console.error("Could not find ha-formfield", formEl);
        }
        let radioEl = formEl.querySelector('ha-radio');
        let textEl = formEl.querySelector('ha-textfield');
        if (!radioEl || !textEl) {
            console.error('could not find sub radio/textfield', radioEl, textEl);
        }
        radioEl.checked = true;
        this._currValue = textEl.value;
    }
}

// innerHtml is something returned by html``
function jCreateDialog(element, titleStr, innerElem) {
    jFireEvent(element, "show-dialog", {
        dialogTag: "more-info-alert2-container",
        dialogImport: () => new Promise((resolve)=> { resolve(); }),
        dialogParams: {
            //entityName: entityName,
            titleStr: titleStr,
            innerElem: innerElem,
            //innerHtml: innerHtml,
        },
        addHistory: true
    });
}

// Similar to ha-more-info-dialog from src/dialogs/more-info/ha-more-info-dialog.ts
class MoreInfoAlert2Container extends LitElement {
    static properties = {
        open: {},
        large: {reflect: true, type: Boolean},
        _hass: { state: true },
        //hass: { attribute: false },
    }
    constructor() {
        super();
        this.config = null;
        this.large = true;
        this._hass = null;
    }
    set hass(nhass) {
        this._hass = nhass;
        if (this.config) {
            this.config.innerElem.hass = nhass;
        }
    }
    setConfig(config) {
        this.config = config;
    }
    showDialog(dialogParams) {
        //console.log('MoreInfoAlert2Container showDialog called', dialogParams);
        this.open = true;
        this.setConfig(dialogParams);
    }
    closeDialog() {
        this.open = false;
        jFireEvent(this, "dialog-closed", { dialog: this.localName });
    }
    connectedCallback() {
        super.connectedCallback();
        //this.getRootNode().querySelector('div.content').style.maxWidth = '60em';
    }
    disconnectedCallback() {
        super.disconnectedCallback();
        let adiv = this.getRootNode().querySelector('div.content');
        if (adiv) { // This may be useless. Seems like sometimes, when element is removed from DOM, the div.content is removed as well.
            adiv.style.maxWidth = null;
        }
    }
    //shouldUpdate(changedProps) {
    //    console.log(' MoreInfoAlert2Container shouldUpdate called ', changedProps);
    //    return true;
    //}
    render() {
        if (!this._hass) {
            return html`<div>waiting for hass</div>`;
        }
        if (!this.config) {
            return html`<div>waiting for config</div>`;
        }
        if (!this.open) {
            return html``;
        }
        //let stateObj = this.hass.states[this.config.entityName];
        let title = this.config.titleStr;
        if (0) {
            let friendlyName = stateObj.attributes.friendly_name2;
            let entityName = this.config.entityName;
            if (friendlyName) {
                title += `"${friendlyName}" (entity ${entityName})`;
            } else {
                title += entityName;
            }
        }
        //let innerHtml = this.config.innerHtml;
        let innerElem = this.config.innerElem;
        //<more-info-alert2  dialogInitialFocus .stateObj=${stateObj} .hass=${this.hass} ></more-info-alert2>
        return html`
           <ha-dialog open @closed=${this.closeDialog} .heading=${true} hideActions flexContent  >
              <ha-dialog-header slot="heading">
                <mwc-icon-button .label=${"dismiss"} dialogAction="cancel" slot="navigationIcon" ><ha-icon .icon=${"mdi:close"} ></ha-icon>
                  </mwc-icon-button>
                <span class="main-title" slot="title" .title=${title} > ${title} </span>
              </ha-dialog-header>
              <div class="content" tabindex="-1" dialogInitialFocus>
                  ${innerElem}
             </div>
           </ha-dialog>
        `;
    }
    static styles = css`
        .content {
          display: flex;
          flex-direction: column;
          outline: none;
          flex: 1;
        }
        /********** below is from https://github.com/thomasloven/lovelace-card-tools/blob/master/src/popup.js ***/
          ha-dialog {
            --mdc-dialog-min-width: 400px;
            --mdc-dialog-max-width: 600px;
            --mdc-dialog-heading-ink-color: var(--primary-text-color);
            --mdc-dialog-content-ink-color: var(--primary-text-color);
            --justify-action-buttons: space-between;
          }
          @media all and (max-width: 450px), all and (max-height: 500px) {
            ha-dialog {
              --mdc-dialog-min-width: 100vw;
              --mdc-dialog-max-width: 100vw;
              --mdc-dialog-min-height: 100%;
              --mdc-dialog-max-height: 100%;
              --mdc-shape-medium: 0px;
              --vertial-align-dialog: flex-end;
            }
          }

          ha-dialog-header {
            flex-shrink: 0;
            color: var(--primary-text-color);
            background-color: var(--secondary-background-color);
          }

          .main-title {
            white-space: wrap;
            word-break: break-all;
            /* margin-left: 16px; */
            /* line-height: 1.3em; */
            /* max-height: 2.6em; */
            /* display: -webkit-box; */
            /* overflow: hidden; */
            /* text-overflow: ellipsis; */
            /* -webkit-line-clamp: 2; */
            /* -webkit-box-orient: vertical; */
          }
          /* .content {            margin: -20px -24px;          } */

          @media all and (max-width: 450px), all and (max-height: 500px) {
            ha-dialog-header {
              background-color: var(--app-header-background-color);
              color: var(--app-header-text-color, white);
            }
          }

          @media all and (min-width: 451px) and (min-height: 501px) {
            ha-dialog {
              --mdc-dialog-max-width: 90vw;
            }

            .content {
              width: 400px;
            }
            :host([large]) .content {
              width: calc(90vw - 48px);
            }

            /*  :host([large]) ha-dialog-header {  max-width: calc(90vw - 32px); } */
          }
    `;
}

customElements.define('more-info-alert2-container', MoreInfoAlert2Container);
customElements.define('more-info-alert2', MoreInfoAlert2);
customElements.define('alert2-overview', Alert2Overview);
customElements.define('hui-alert2-entity-row', Alert2EntityRow);
customElements.define('ha-alert2-state', HaAlert2State);
customElements.define('j-relative-time', RelativeTime);
customElements.define("state-card-alert2", StateCardAlert2);

class Alert2Tools {
    static get fireEvent() { return jFireEvent; }
    static get createDialog() { return jCreateDialog; }
    static get html() { return html; }
};
customElements.define('alert2-tools', Alert2Tools);



//
// --------------------------------------------------------------------------------
// Logic for  Alert Manger
//

class Alert2Manager extends LitElement {
    static properties = {
        open: {},
        large: {reflect: true, type: Boolean},
        _hass: { state: true },
        //hass: { attribute: false },
    }
    constructor() {
        super();
        this._hass = null;
    }
    set hass(newHass) {
        const oldHass = this._hass;
        this._hass = newHass;
        this._config = null;
    }
    setConfig(config) {
        this._config = config;
    }
    render() {
        if (!this._hass) {
            return html`<div>Loading.. waiting for hass to load</div>`;
        }
        return html`<ha-card>
            <h1 class="card-header"><div class="name">Alert2 Manager</div></h1>
            <div class="card-content">
              <div style="display:flex; align-items: center; margin-bottom: 1em;">
                  <ha-progress-button .progress=${this._ackAllInProgress}
                    @click=${this.editDefaults}>Edit defaults</ha-progress-button>
                  <ha-progress-button .progress=${this._ackAllInProgress}
                    @click=${this.createNew}>Create new alert</ha-progress-button>
              </div>
            </div>
          </ha-card>`;
    }
    async createNew(ev) {
        let innerElem = document.createElement('alert2-create');
        innerElem.hass = this._hass;
        jCreateDialog(this, 'a new alert?', innerElem);
    }
    async editDefaults(ev) {
        let innerElem = document.createElement('alert2-edit-defaults');
        innerElem.hass = this._hass;
        jCreateDialog(this, 'Alert2 Defaults', innerElem);
    }
    static styles = css`
      .card-header {
        display: flex;
        justify-content: space-between;
      }
      .card-header .name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
      }
      .header {
        border-top-left-radius: var(--ha-card-border-radius, 12px);
        border-top-right-radius: var(--ha-card-border-radius, 12px);
        margin-bottom: 16px;
        overflow: hidden;
      }
      .footer {
        border-bottom-left-radius: var(--ha-card-border-radius, 12px);
        border-bottom-right-radius: var(--ha-card-border-radius, 12px);
        margin-top: -16px;
        overflow: hidden;
      }
    `;
};

function isFloat(a) {
    let v = Number(a);
    return !isNaN(v);
}
function isTruthy(a) {
    return !isNaN(parseInt(a)) || ['yes','no','on','off','true','false'].includes(a.toLowerCase());
}
function makeEnum(obj) {
    return new Proxy(obj, { get(target, name) { if (obj[name]) { return obj[name] } else { throw new Error(`field ${name} not in obj`); } } });
}
const debounce = (callback, wait) => {
  let timeoutId = null;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      callback(...args);
    }, wait);
  };
}
function displayStr(tval) {
    if (Array.isArray(tval)) {
        if (tval.length == 0) { return '[]' }
        if (tval.length == 1) { return tval[0] }
        if (typeof(tval[0]) == 'string') {
            let n = tval.map((v)=> `"${v}"`);
            return '[ ' + n.join(',') + ' ]';
        } else {
            return '[ ' + tval.join(',') + ' ]';
        }
    }
    return tval;
}

let TopTypes = makeEnum({ COND:  'cond', EVENT:  "event", GENERATOR: "generator" });
let FieldTypes = makeEnum({ TEMPLATE: 'template', FLOAT:  "float", STR: "str", BOOL: 'bool' });
let TemplateTypes = makeEnum({ LIST: 'list' }) //, CONDITION: 'condition', STRING: 'str' });

class Alert2CfgField extends LitElement {
    static properties = {
        hass: { attribute: false },
        name: {  },
        type: {  }, // FieldTypes
        templateType: {  },
        defaultP: { attribute: false },
        savedP: { attribute: false },
        currP: { attribute: false },
        namePrefix: {},
        //value: { attribute: false },
        //finalVal: { attribute: false },
        //defaultVal: { attribute: false },
        //topConfigs: { attribute: false },
        //default: { attribute: false },
        required: { type: Boolean }, // 'type' is so can specify as attribute rather than prop
        expanded: { attribute: false },
        renderInfo: { state: true },
        genResult : { attribute: false },
        //inDefaults: { state: true },
    }
    constructor() {
        super();
        this.expanded = false;
        this.required = false; // default
        this.renderD = debounce(this.doRenderTemplate.bind(this), 750);
        this.renderInfo = { rendering: false, error: null, result: null };
        this.focusOnce = false;
    }
    connectedCallback() {
        super.connectedCallback();
        if (!this.currP) {
            throw new Error("this.currP undefined");
        }
    }
    async doRenderTemplate() {
        let value = uToE(this.getValue());
        if (!value) {
            this.renderInfo = { rendering: false, error: null, result: null };
            return;
        }
        this.renderInfo = { rendering: true, error: null, result: null };
        let nameToUse = (this.namePrefix? (this.namePrefix+'.') : '') + this.name;
        let retv;
        //console.log('doRenderTemplate', this.name, this.genResult);
        let extraVars = this.genResult ? this.genResult.firstElemVars : {};
        try {
            retv = await this.hass.callApi('POST', 'alert2/renderValue',
                                           //{ type: this.templateType, txt: value });
                                           { txt: value, name: nameToUse, extraVars: extraVars });
        } catch (err) {
            this.renderInfo = { rendering: false, error: 'http err: ' + JSON.stringify(err),
                                result: null };
            return;
        }
        let resp = { rendering: false };
        if (Object.hasOwn(retv, 'error')) {
            resp.error = retv.error;
        }
        if (Object.hasOwn(retv, 'rez')) {
            resp.result = retv.rez;
        }
        if (Object.keys(resp).length == 1) {
            this.renderInfo = { rendering: false, error: 'bad result: ' + JSON.stringify(retv),
                                result: null };
        } else {
            this.renderInfo = resp;
            if (this.name == 'generator') {
                jFireEvent(this, "generator-result", { generatorResult: resp.result });
            }
        }
    }
    setConfig(config) {
        this._cardConfig = config;
    }
    _click(ev) {
        this.expanded = !this.expanded;
        if (this.expanded) {
            this.focusOnce = true;
        }
        jFireEvent(this, "expand-click", { expanded: this.expanded });
        // this.renderD() just so we update if, e.g. generator was changed and user is checking out this
        // particular field to see what the effect was
        this.renderD(); 
    }
    _change(ev) {
        let value = ev.detail?.value || ev.target.value;
        //console.log('_change', value);
        let parentP = this.currP;
        if (this.namePrefix) {
            parentP = parentP[this.namePrefix];
        }
               
        if (value.trim() === '') {
            if (parentP) {
                delete parentP[this.name];
                if (this.namePrefix && (Object.keys(this.parentP).length == 0)) {
                    delete this.currP[this.namePrefix];
                }
            } // otherwise no entry to delete
        } else {
            if (parentP === undefined) { // means must be using namePrefix
                this.currP[this.namePrefix] = {};
                parentP = this.currP[this.namePrefix];
            }
            parentP[this.name] = value;
            this.renderD();
        }
        jFireEvent(this, "change", { });
    }
    getValue() {
        if (this.namePrefix) {
            if (this.currP[this.namePrefix]) {
                return this.currP[this.namePrefix][this.name];
            }
            return null;
        }
        return this.currP[this.name];
    }
        
    async firstFocus() {
        await this.updateComplete;
        //console.log(this.shadowRoot.querySelectorAll('ha-textfield'));
        //console.log(this.shadowRoot.querySelectorAll('ha-code-editor'));
        let els = this.shadowRoot.querySelectorAll('ha-textfield, ha-code-editor');
        //console.log(els);
        if (els) {
            console.log('focusing on ', els[0].nodeName);
            if (els[0].nodeName == 'HA-TEXTFIELD') {
                els[0].focus();
            } else {
                let tries = 0;
                let checkInt = setInterval(()=>{
                    tries += 1;
                    let subel = els[0].shadowRoot.querySelector('div.cm-content');
                    if (subel) { // code editor might aready have been closed
                        subel.focus();
                        clearInterval(checkInt);
                    } else {
                        if (tries > 15) {
                            console.warn('ha-code-editor element did not materialize to get focus within ~5s');
                            clearInterval(checkInt);
                        }
                    }
                }, 300);
            }
            //this.addEventListener("focusin", (event) => { console.log('focusin', event); });
            this.focusOnce = false;
        }
    }
    render() {
        if (!this.hass) { return "waiting for hass"; }
        let value = uToE(this.getValue());
        let origValue = uToE(this.savedP[this.name]);
        let unsavedChange = html`<span style=${(value == origValue) ? 'visibility: hidden;':''}>*</span>`;
        let hasDefault = !!this.defaultP;
        let defaultValue = hasDefault ? uToE(this.defaultP[this.name]) : '';
        let finalValue = (hasDefault && value == '') ? defaultValue : value;
        
        if (this.expanded) {
            let editElem;
            //let renderHtml = '';
            let renderedStr = ''+displayStr(this.renderInfo.result);
            let lenStr = '';
            if (this.type == FieldTypes.STR) {
                editElem = html`<ha-textfield .required=${this.required} type="text" .value=${value}
                                       @input=${this._change} ></ha-textfield>`;
            } else if (this.type == FieldTypes.FLOAT) {
                editElem = html`<ha-textfield .required=${this.required} type="number" .value=${value}
                                       @input=${this._change} ></ha-textfield>`;
            } else if (this.type == FieldTypes.BOOL) {
                editElem = html`<ha-textfield .required=${this.required} type="text" .value=${value}
                                       @input=${this._change} ></ha-textfield>`;
            } else if (this.type == FieldTypes.TEMPLATE) {
                if (this.templateType == TemplateTypes.LIST && this.renderInfo.result) {
                    let firstOnly = '';
                    if (this.name == 'generator') {
                        if (this.renderInfo.result.len > this.renderInfo.result.list.length) {
                            firstOnly = `showing first ${this.renderInfo.result.list.length}`;
                        }
                        renderedStr = JSON.stringify(this.renderInfo.result);
                    } else {
                        renderedStr = JSON.stringify(this.renderInfo.result);
                    }
                    lenStr = html` (len=${this.renderInfo.result.length}${firstOnly})`;
                    console.log('list result', this.renderInfo.result);
                }
                editElem = html`<ha-code-editor mode="jinja2" .hass=${this.hass} .value=${value} .readOnly=${false}
                  autofocus autocomplete-entities autocomplete-icons @value-changed=${this._change} dir="ltr"
                  linewrap ></ha-code-editor>`;
            } else {
                console.error('wrong type for field', this.name, this.type);
            }
            let renderHtml = (this.renderInfo.result != null) ? html`<div style="display: flex; flex-flow: row; align-items:center;">Render result${lenStr}:<div class="rendered" style="margin-left: 1em;">${renderedStr}</div></div>`:"";
            if (this.focusOnce) {
                // I wish we had access to Lit's ref() directive.  Sigh.
                this.firstFocus(); // async func
            }
            return html`
               <div class="cfield">
                 <div class="name" @click=${this._click} >${unsavedChange}${this.name}${this.required ? "*":""}:</div>
                 <div style="display: flex; flex-flow: column;">
                    <div class="avalue">${editElem}</div>
                    ${this.renderInfo.rendering ?
                        html`<ha-circular-progress class="render-spinner" indeterminate size="small" ></ha-circular-progress>` : 
                        this.renderInfo.error != null ?
                            html`<ha-alert alert-type=${"warning"}>${this.renderInfo.error}</ha-alert>` : ""}
                    <div style="margin-left: 1em;">
                      ${renderHtml}
                      ${hasDefault ? html`<div>Default if empty: <code>${displayStr(defaultValue)}</code></div>`:''}
                      <slot name="help" class="shelp"></slot>
                    </div>
                 </div>
               </div>`;
        } else {
            let x = html`
               <div class="cfield" @click=${this._click}>
                 <div class="name">${unsavedChange}${this.name}${this.required ? "*":""}:</div>
                 ${this.renderInfo.error != null ? html`<div style="background: var(--warning-color); height:1.5em; width: 0.3em; margin-right:0.3em;"></div>`:""}
                 <code class="avalue">${displayStr(finalValue)}</code>
               </div>`;
            return x;
        }

    }
    static styles = css`
       .cfield {
          display: flex;
          flex-flow: row wrap;
          align-items: center;
       }
       .name {
          margin-right: 1em;
          cursor: pointer;
          min-width: 14em;
       }
       .shelp {
          font-size: 0.9em;
       }
       .shelp > ul {
          margin-top: 0.1em;
          margin-bottom: 0;
       }
       pre {
          margin: 0;
       }
       .rendered {
          font-family: ui-monospace, monospace;
       }
     }
    `;
}

function uToE(val) { return (val == undefined) ? '' : (val); }
function closeOtherExpanded(elem, ev) {
    // Unexpand other fields when one expands.
    let expanded = ev.detail?.expanded;
    let targetEl = ev.target;
    //console.log('expandClick', expanded, this.nodeName, ev);
    if (expanded) {
        let els = elem.shadowRoot.querySelectorAll('alert2-cfg-field');
        els.forEach((el)=> {
            if (el !== targetEl) {
                el.expanded = false;
            }
        });
    }
}

class Alert2EditDefaults extends LitElement {
    static properties = {
        hass: { attribute: false },
        _topConfigs: { state: true },
        _serverErr: { state: true },
        _saveInProgress: { state: true },
    }
    constructor() {
        super();
    }
    setConfig(config) {
        this._cardConfig = config;
    }
    connectedCallback() {
        super.connectedCallback();
        this.refresh();
    }
    async refresh() {
        let retv;
        try {
            this._topConfigs = await this.hass.callApi('POST', 'alert2/loadTopConfig', {});
            this._topConfigs.origRawUi = JSON.parse(JSON.stringify(this._topConfigs.rawUi));
        } catch (err) {
            this._serverErr = 'http err: ' + JSON.stringify(err);
            return;
        }
        console.log('got topConfig', this._topConfigs);
    }
    changed(ev, fieldSet) {
        let value = ev.detail?.value || ev.target.value;
        console.log('yay got change: ', value);
        fieldSet(value);
        this._serverErr = null;
    }
    async _save(ev) {
        let abutton = ev.target;
        this._saveInProgress = true;
        let rez;
        try {
            rez = await this.hass.callApi('POST', 'alert2/saveTopConfig',
                                          {topConfig: this._topConfigs.rawUi});
        } catch (err) {
            this._saveInProgress = false;
            abutton.actionError();
            this._serverErr = "error: " + err.message;
            return;
        }
        this._saveInProgress = false;
        if (rez.error) {
            abutton.actionError();
            this._serverErr = "error: " + rez.error;
            return;
        }
        // Update _topConfigs mostly cuz server filters out empty fields,
        // and so we don't drift between browser and server state re configs
        this._topConfigs = rez;
        this._topConfigs.origRawUi = JSON.parse(JSON.stringify(this._topConfigs.rawUi));
        abutton.actionSuccess();
    }
    // Unexpand other fields when one expands.
    expandClick(ev) {
        closeOtherExpanded(this, ev);
    }
    render() {
        if (!this.hass) { return "waiting for hass"; }
        if (!this._topConfigs) { return "waiting for _topConfigs"; }
        return html`
         <div class="container" >
            <h3>Default alert parameters</h3>
            <alert2-cfg-field .hass=${this.hass} name="notifier" type=${FieldTypes.TEMPLATE}
                 templateType=${TemplateTypes.LIST} .defaultP=${this._topConfigs.rawYaml.defaults}
                  @expand-click=${this.expandClick}
                  .savedP=${this._topConfigs.origRawUi.defaults}  .currP=${this._topConfigs.rawUi.defaults} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>

            <alert2-cfg-field .hass=${this.hass} name="summary_notifier" type=${FieldTypes.TEMPLATE}
                 templateType=${TemplateTypes.LIST} .defaultP=${this._topConfigs.rawYaml.defaults}
                  @expand-click=${this.expandClick}
                  .savedP=${this._topConfigs.origRawUi.defaults}  .currP=${this._topConfigs.rawUi.defaults} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="annotate_messages" type=${FieldTypes.BOOL}
                 .defaultP=${this._topConfigs.rawYaml.defaults}
                  @expand-click=${this.expandClick}
                 .savedP=${this._topConfigs.origRawUi.defaults}  .currP=${this._topConfigs.rawUi.defaults} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="reminder_frequency_mins" type=${FieldTypes.STR}
                 .defaultP=${this._topConfigs.rawYaml.defaults}
                  @expand-click=${this.expandClick}
                 .savedP=${this._topConfigs.origRawUi.defaults}  .currP=${this._topConfigs.rawUi.defaults} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="throttle_fires_per_mins" type=${FieldTypes.STR}
                 .defaultP=${this._topConfigs.rawYaml.defaults}
                  @expand-click=${this.expandClick}
                 .savedP=${this._topConfigs.origRawUi.defaults}  .currP=${this._topConfigs.rawUi.defaults} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>

            <h3>Top-level options</h3>
            <alert2-cfg-field .hass=${this.hass} name="skip_internal_errors" type=${FieldTypes.BOOL}
                 .defaultP=${this._topConfigs.rawYaml}
                  @expand-click=${this.expandClick}
                 .savedP=${this._topConfigs.origRawUi}  .currP=${this._topConfigs.rawUi} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="notifier_startup_grace_secs" type=${FieldTypes.FLOAT}
                 .defaultP=${this._topConfigs.rawYaml}
                  @expand-click=${this.expandClick}
                 .savedP=${this._topConfigs.origRawUi}  .currP=${this._topConfigs.rawUi} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="defer_startup_notifications" type=${FieldTypes.STR}
                 .defaultP=${this._topConfigs.rawYaml}
                  @expand-click=${this.expandClick}
                 .savedP=${this._topConfigs.origRawUi}  .currP=${this._topConfigs.rawUi} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            
            <div style="margin-top: 0.5em;"><ha-progress-button .progress=${this._saveInProgress} @click=${this._save}>Save</ha-progress-button></div>
            ${this._serverErr ? html`<ha-alert alert-type=${"error"}>${this._serverErr}</ha-alert>` : ""}
         </div>`;
    }
    static styles = css`
    h3 {
       margin-bottom: 0.3em;
       margin-top: 1.5em;
    }
    h3:first-of-type {
       margin-top: 0em;
    }
      `;
}

function yamlEscape(astr, removeNewline=true) {
    const format = /[{}\[\]&*#?|\-<>=!%@:`,]/;
    astr = astr.replace('\n', ' ');
    if (format.test(astr)) {
        return '"' + astr.replace('"', '\\"') + '"';
    } else {
        return astr;
    }
}
function hasJinjaTempl(astr) {
    const format = /{{|{%|{#/;
    return format.test(astr);
}
function slugify(str) {
    // Allows [] for convenience below. TODO -fix.
    str = str.trim().toLowerCase();
    str = str.replace(/[^a-z0-9 ._\[\]]/g, '')
              .replace(/\s+/g, '_')
              .replace(/_+/g, '_');
  return str;
}
class Alert2Create extends LitElement {
    static properties = {
        hass: { attribute: false },
        //topType: { state: true },
        _topConfigs: { attribute: false },
        _serverErr: { state: true },
        _validateInProgress: { state: true },
        _generatorResult: { state: true },
        alertCfg: { state: true },
    }
    constructor() {
        super();
        //this.topType = TopTypes.COND;
        this.alertCfg = {};
    }
    setConfig(config) {
        this._cardConfig = config;
    }
    connectedCallback() {
        super.connectedCallback();
        this.init();
    }
    async init() {
        try {
            this._topConfigs = await this.hass.callApi('POST', 'alert2/loadTopConfig', {});
        } catch (err) {
            this._topConfigs = { error: 'http err: ' + JSON.stringify(err) };
        }
    }
    expandClick(ev) {
        closeOtherExpanded(this, ev);
    }
    async _validate(ev) {
        let abutton = ev.target;
        this._validateInProgress = true;
        let rez;
        console.log('validate of', this.alertCfg);
        try {
            rez = await this.hass.callApi('POST', 'alert2/manageAlert',
                                          { validate: this.alertCfg });
        } catch (err) {
            this._validateInProgress = false;
            abutton.actionError();
            this._serverErr = "error: " + err.message;
            return;
        }
        this._validateInProgress = false;
        if (rez.error) {
            abutton.actionError();
            this._serverErr = "error: " + rez.error;
            return;
        }
        abutton.actionSuccess();
    }
    _change(ev) {
        //console.log('editor _change');
        //if (this.alertCfg.threshold && Object.keys(this.alertCfg.threshold).length == 0) {
        //    delete this.alertCfg.threshold;
        // }
        this._serverErr = null;
        this.requestUpdate();
    }
    _generator_rez(ev) {
        this._generatorResult = ev.detail?.generatorResult;
        console.log('_generator_rez', ev.detail, this._generatorResult);
    }
    configToYaml() {
        let yaml = 'alert2:';
        yaml += '\n  alerts:';
        let isFirst = true;
        Object.keys(this.alertCfg).forEach((fname)=> {
            yaml += `\n   ${isFirst ? "- " : "  "}`;
            isFirst = false;
            if (fname === 'threshold') {
                yaml += 'threshold:';
                Object.keys(this.alertCfg[fname]).forEach((fname2)=> {
                    yaml += `\n      ${fname2}: ${yamlEscape(this.alertCfg[fname][fname2])}`;
                });
            } else {
                let rawVal = this.alertCfg[fname].trim();
                let val;
                if (['domain','name', 'friendly_name', 'condition', 'message', 'title', 'target',
                     'annotate_messages', 'early_start', 'generator_name',
                     'done_message', 'delay_on_secs'].includes(fname)) {
                    val = yamlEscape(rawVal);
                } else if (['trigger', 'data', 'throttle_fires_per_mins', 'reminder_frequency_mins',
                            ].includes(fname)) {
                    val = rawVal;
                } else if (['generator', 'notifier', 'summary_notifier'].includes(fname)) {
                    if (hasJinjaTempl(rawVal)) {
                        val = yamlEscape(rawVal);
                    } else {
                        // TODO - if val is array, then individually yamlEscape the elements.
                        val = rawVal;
                    }
                }
                if (['trigger', 'data'].includes(fname)) {
                    val = val.replace('\n', '\n      ');
                    yaml += `${fname}:\n      ${val}`;
                } else {
                    yaml += `${fname}: ${val}`;
                }
            }
        });
        return yaml;
    }
    
    render() {
        //console.log('render with this._generatorResult=', this._generatorResult);
        if (!this.hass) {
            return html`waiting for hass`;
        }
        if (!this._topConfigs) {
            return html`waiting for _topConfigs to load`;
        }
        if (this._topConfigs.error) {
            return html`<ha-alert alert-type="error">Loading _topConfigs: ${this._topConfigs.error}</ha-alert>`;
        }
        let entName = `alert2.${this.alertCfg.domain ? this.alertCfg.domain : "[domain]"}_${this.alertCfg.name ? this.alertCfg.name : "[name]"}`;
        entName = slugify(entName);
        let yaml = this.configToYaml();
        if (0) {
            let old = html`
         <div class="container">
            <ha-list>
              <ha-list-item twoline graphic="control" @click=${(ev)=>{ this._topClick(TopTypes.COND, ev) }}>
                  <span>Condition</span>
                  <span slot="graphic"><ha-radio .checked=${this.topType==TopTypes.COND} .value=${TopTypes.COND}
                    @change=${this._topRadioClick} ></ha-radio></span>
                  <span slot="secondary">Fires while a condition is satisfied</span></ha-list-item>
              <ha-list-item twoline graphic="control" @click=${(ev)=>{ this._topClick(TopTypes.EVENT, ev) }}>
                  <span>Event</span>
                  <span slot="graphic"><ha-radio .checked=${this.topType==TopTypes.EVENT} .value=${TopTypes.EVENT}
                    @change=${this._topRadioClick} ></ha-radio></span>
                  <span slot="secondary">Fires when triggered</span></ha-list-item>
              <ha-list-item twoline graphic="control" @click=${(ev)=>{ this._topClick(TopTypes.GENERATOR, ev) }}>
                  <span>Generator</span>
                  <span slot="graphic"><ha-radio .checked=${this.topType==TopTypes.GENERATOR} .value=${TopTypes.GENERATOR}
                    @change=${this._topRadioClick} ></ha-radio></span>
                  <span slot="secondary">Use patterns to generate multiple alert entities</span></ha-list-item>
            </ha-list>
         </div>
         `;

        }

        return html`
         <div class="container">
            <h3>Entity name: <code>${entName}</code></h3>
            <alert2-cfg-field .hass=${this.hass} name="domain" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change}
                 .savedP=${{}}  .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text 33
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="name" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change}
                 .savedP=${{}}  .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="friendly_name" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>

            <h3>Fire control</h3>
            <alert2-cfg-field .hass=${this.hass} name="condition" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="trigger" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <div><span style="visibility:hidden">*</span>Threshold <div style="margin-left: 1.5em;">
               <alert2-cfg-field .hass=${this.hass} name="value" type=${FieldTypes.TEMPLATE}
                    @expand-click=${this.expandClick} @change=${this._change} namePrefix="threshold"
                     templateType=${TemplateTypes.LIST} .genResult=${this._generatorResult}
                     .savedP=${{}} .currP=${this.alertCfg} >
                  <div slot="help">
                      some help text
                  </div></alert2-cfg-field>
               <alert2-cfg-field .hass=${this.hass} name="hysteresis" type=${FieldTypes.STR}
                    @expand-click=${this.expandClick} @change=${this._change} namePrefix="threshold"
                     .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
                  <div slot="help">
                      some help text
                  </div></alert2-cfg-field>
               <alert2-cfg-field .hass=${this.hass} name="maximum" type=${FieldTypes.STR}
                    @expand-click=${this.expandClick} @change=${this._change} namePrefix="threshold"
                     .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
                  <div slot="help">
                      some help text
                  </div></alert2-cfg-field>
               <alert2-cfg-field .hass=${this.hass} name="minimum" type=${FieldTypes.STR}
                    @expand-click=${this.expandClick} @change=${this._change} namePrefix="threshold"
                     .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
                  <div slot="help">
                      some help text
                  </div></alert2-cfg-field>
            </div></div>
            <alert2-cfg-field .hass=${this.hass} name="delay_on_secs" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change} .defaultP=${this._topConfigs.raw.defaults}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="early_start" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change} .defaultP=${this._topConfigs.raw.defaults}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>

            <h3>Notifications</h3>
            <alert2-cfg-field .hass=${this.hass} name="message" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="done_message" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="notifier" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change} .defaultP=${this._topConfigs.raw.defaults}
                  templateType=${TemplateTypes.LIST} .genResult=${this._generatorResult}
                  .savedP=${{}} .currP=${this.alertCfg} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="summary_notifier" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change} .defaultP=${this._topConfigs.raw.defaults}
                  templateType=${TemplateTypes.LIST} .genResult=${this._generatorResult}
                  .savedP=${{}} .currP=${this.alertCfg} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="title" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="target" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="data" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="throttle_fires_per_mins" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change} .defaultP=${this._topConfigs.raw.defaults}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="reminder_frequency_mins" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change} .defaultP=${this._topConfigs.raw.defaults}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="annotate_messages" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change} .defaultP=${this._topConfigs.raw.defaults}
                  .savedP=${{}} .currP=${this.alertCfg} .genResult=${this._generatorResult} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <h3>Generator</h3>
            <alert2-cfg-field .hass=${this.hass} name="generator" type=${FieldTypes.TEMPLATE}
                 @expand-click=${this.expandClick} @change=${this._change}
                  templateType=${TemplateTypes.LIST} @generator-result=${this._generator_rez}
                  .savedP=${{}} .currP=${this.alertCfg} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>
            <alert2-cfg-field .hass=${this.hass} name="generator_name" type=${FieldTypes.STR}
                 @expand-click=${this.expandClick} @change=${this._change}
                  .savedP=${{}} .currP=${this.alertCfg} >
               <div slot="help">
                   some help text
               </div></alert2-cfg-field>

            <div style="margin-top: 0.5em;"><ha-progress-button .progress=${this._validateInProgress} @click=${this._validate}>Validate</ha-progress-button></div>
            ${this._serverErr ? html`<ha-alert alert-type=${"error"}>${this._serverErr}</ha-alert>` : ""}

            <hr style="width:60%; max-width: 10em; margin-left: 0; margin-top: 2em;">

            <h3>Output</h3>
            <div>YAML:</div>
            <pre class="output">${yaml}</pre>


        `;
    }
    
    static styles = css`
    .container {
        margin-bottom: 1em;
     }
     .output {
        background-color: var(--secondary-background-color);
        padding: 8px;
     }
      `;
    _topRadioClick(ev) {
        let value = ev.detail?.value || ev.target.value;
        //console.log('radio clicked', value);
    }
    _topClick(name, ev) {
        //console.log('top clicked', name, TopTypes.EVENT, this);
        this.topType = name;
    }
    _domainChange(ev) {
        let value = ev.detail?.value || ev.target.value;
        this.alertCfg.domain = value;
    }
    _nameChange(ev) {
        let value = ev.detail?.value || ev.target.value;
        this.alertCfg.name = value;
    }
    _friendlynameChange(ev) {
        let value = ev.detail?.value || ev.target.value;
        this.alertCfg.friendly_name = value;
    }
    _conditionChange(ev) {
        let value = ev.detail?.value || ev.target.value;
        this.conditionTxt = value;
        this.conditionEvalD(); // will call conditionEval in a bit
    }
    async doConditionEval() {
        if (!this.conditionTxt) {
            this.conditionEval = { rendering: false, error: null, result: null };
            return;
        }
        this.conditionEval = { rendering: true, error: null, result: null };
        console.log('cond eval', this.conditionTxt);
        let retv;
        try {
            retv = await this.hass.callApi('POST', 'alert2/templateRender',
                                           { type: 'condition', txt: this.conditionTxt });
        } catch (err) {
            this.conditionEval = { rendering: false, error: 'http err: ' + JSON.stringify(err), result: null };
            return;
        }
        console.log('got render response: ', retv);
        if (Object.hasOwn(retv, 'error')) {
            this.conditionEval = { rendering: false, error: retv.error, result: null };
        } else if (Object.hasOwn(retv, 'rez')) {
            this.conditionEval = { rendering: false, error: null, result: retv.rez };
        } else {
            this.conditionEval = { rendering: false, error: 'bad result: ' + JSON.stringify(retv), result: null };
        }
    }
}

customElements.define('alert2-manager', Alert2Manager);
customElements.define('alert2-create', Alert2Create);
customElements.define('alert2-edit-defaults', Alert2EditDefaults);
customElements.define('alert2-cfg-field', Alert2CfgField);
