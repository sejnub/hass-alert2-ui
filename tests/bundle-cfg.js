//
// cd ~/server
// npm install --save-dev rollup lit @material/mwc-button @material/mwc-formfield @material/mwc-radio @material/mwc-textfield @material/web
// npx rollup -p '@rollup/plugin-node-resolve={modulePaths:["/home/redstone/server/node_modules"]}' ~/tmp/hass-alert2-ui/tests/bundle-cfg.js -o ~/tmp/hass-alert2-ui/tests/lit-material.js
//
import {LitElement, html, css} from 'lit';
import { FormfieldBase }           from "@material/mwc-formfield/mwc-formfield-base";
import { styles as formStyles }    from "@material/mwc-formfield/mwc-formfield.css";
import                                  "@material/mwc-button";
import { RadioBase }               from "@material/mwc-radio/mwc-radio-base";
import { styles as radioStyles }   from "@material/mwc-radio/mwc-radio.css";
import { TextFieldBase }           from "@material/mwc-textfield/mwc-textfield-base";
import {styles as textfieldStyles} from "@material/mwc-textfield/mwc-textfield.css";
import { MdListItem, MdSlider }    from '@material/web/all.js';

export { MdListItem, MdSlider, textfieldStyles, TextFieldBase, radioStyles, RadioBase,
         formStyles, FormfieldBase, LitElement, html, css  };
