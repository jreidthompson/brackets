/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, $, CodeMirror, window, Mustache */

define(function (require, exports, module) {
    "use strict";
    
    // Load dependent modules
    var CSSUtils                = require("language/CSSUtils"),
        CommandManager          = require("command/CommandManager"),
        Commands                = require("command/Commands"),
        DocumentManager         = require("document/DocumentManager"),
        DropdownEventHandler    = require("utils/DropdownEventHandler").DropdownEventHandler,
        EditorManager           = require("editor/EditorManager"),
        Editor                  = require("editor/Editor").Editor,
        FileIndexManager        = require("project/FileIndexManager"),
        HTMLUtils               = require("language/HTMLUtils"),
        Menus                   = require("command/Menus"),
        MultiRangeInlineEditor  = require("editor/MultiRangeInlineEditor"),
        PopUpManager            = require("widgets/PopUpManager"),
        Strings                 = require("strings"),
        _                       = require("lodash");

    var StylesheetsMenuTemplate = require("text!htmlContent/stylesheets-menu.html");
    
    var _newRuleCmd,
        _newRuleHandlers = [];

    /**
     * Given a position in an HTML editor, returns the relevant selector for the attribute/tag
     * surrounding that position, or "" if none is found.
     * @param {!Editor} editor
     * @private
     */
    function _getSelectorName(editor, pos) {
        var tagInfo = HTMLUtils.getTagInfo(editor, pos),
            selectorName = "";
        
        if (tagInfo.position.tokenType === HTMLUtils.TAG_NAME || tagInfo.position.tokenType === HTMLUtils.CLOSING_TAG) {
            // Type selector
            selectorName = tagInfo.tagName;
        } else if (tagInfo.position.tokenType === HTMLUtils.ATTR_NAME ||
                   tagInfo.position.tokenType === HTMLUtils.ATTR_VALUE) {
            if (tagInfo.attr.name === "class") {
                // Class selector. We only look for the class name
                // that includes the insertion point. For example, if
                // the attribute is: 
                //   class="error-dialog modal hide"
                // and the insertion point is inside "modal", we want ".modal"
                var attributeValue = tagInfo.attr.value;
                var startIndex = attributeValue.substr(0, tagInfo.position.offset).lastIndexOf(" ");
                var endIndex = attributeValue.indexOf(" ", tagInfo.position.offset);
                selectorName = "." +
                    attributeValue.substring(
                        startIndex === -1 ? 0 : startIndex + 1,
                        endIndex === -1 ? attributeValue.length : endIndex
                    );
                
                // If the insertion point is surrounded by space, selectorName is "."
                // Check for that here
                if (selectorName === ".") {
                    selectorName = "";
                }
            } else if (tagInfo.attr.name === "id") {
                // ID selector
                selectorName = "#" + tagInfo.attr.value;
            }
        }
        
        return selectorName;
    }

    /**
     * @private
     * Create the list of stylesheets in the dropdown menu.
     * @return {string} The html content
     */
    function _renderList(cssFileInfos) {
        var templateVars   = {
                styleSheetList : cssFileInfos
            };

        return Mustache.render(StylesheetsMenuTemplate, templateVars);
    }

    /**
     * @private
     * Add a new rule for the given selector to the given stylesheet, then add the rule to the
     * given inline editor.
     * @param {string} selectorName The selector to create a rule for.
     * @param {MultiRangeInlineEditor} inlineEditor The inline editor to display the new rule in.
     * @param {string} path The path to the stylesheet file.
     */
    function _addRule(selectorName, inlineEditor, path) {
        DocumentManager.getDocumentForPath(path).done(function (styleDoc) {
            var newRuleInfo = CSSUtils.addRuleToDocument(styleDoc, selectorName, Editor.getUseTabChar(), Editor.getSpaceUnits());
            inlineEditor.addAndSelectRange(selectorName, styleDoc, newRuleInfo.range.from.line, newRuleInfo.range.to.line);
            inlineEditor.editor.setCursorPos(newRuleInfo.pos.line, newRuleInfo.pos.ch);
        });
    }
    
    /**
     * @private
     * Handle the "new rule" menu item by dispatching it to the handler for the focused inline editor.
     */
    function _handleNewRule() {
        var inlineEditor = MultiRangeInlineEditor.getFocusedMultiRangeInlineEditor();
        if (inlineEditor) {
            var handlerInfo = _.find(_newRuleHandlers, function (entry) {
                return entry.inlineEditor === inlineEditor;
            });
            if (handlerInfo) {
                handlerInfo.handler();
            }
        }
    }
    
    /**
     * This function is registered with EditManager as an inline editor provider. It creates a CSSInlineEditor
     * when cursor is on an HTML tag name, class attribute, or id attribute, find associated
     * CSS rules and show (one/all of them) in an inline editor.
     *
     * @param {!Editor} editor
     * @param {!{line:Number, ch:Number}} pos
     * @return {$.Promise} a promise that will be resolved with an InlineWidget
     *      or null if we're not going to provide anything.
     */
    function htmlToCSSProvider(hostEditor, pos) {

        // Only provide a CSS editor when cursor is in HTML content
        if (hostEditor.getLanguageForSelection().getId() !== "html") {
            return null;
        }
        
        // Only provide CSS editor if the selection is within a single line
        var sel = hostEditor.getSelection();
        if (sel.start.line !== sel.end.line) {
            return null;
        }
        
        // Always use the selection start for determining selector name. The pos
        // parameter is usually the selection end.
        var selectorName = _getSelectorName(hostEditor, sel.start);
        if (selectorName === "") {
            return null;
        }

        var result = new $.Deferred(),
            cssInlineEditor,
            cssFileInfos = [],
            $newRuleButton,
            $dropdown,
            $dropdownItem,
            dropdownEventHandler;

        /**
         * @private
         * Close the dropdown externally to dropdown, which ultimately calls the
         * _cleanupDropdown callback.
         */
        function _closeDropdown() {
            if (dropdownEventHandler) {
                dropdownEventHandler.close();
            }
        }
        
        /**
         * @private
         * Remove the various event handlers that close the dropdown. This is called by the
         * PopUpManager when the dropdown is closed.
         */
        function _cleanupDropdown() {
            $("html").off("click", _closeDropdown);
            dropdownEventHandler = null;
            $dropdown = null;
    
            EditorManager.focusEditor();
        }

        /**
         * @private
         * Callback when item from dropdown list is selected
         * @param {jQueryObject} $link  The `a` element selected with mouse or keyboard
         */
        function _onSelect($link) {
            var path  = $link.data("path");

            if (path) {
                _addRule(selectorName, cssInlineEditor, path);
            }
        }
        
        /**
         * @private
         * Show or hide the stylesheets dropdown.
         */
        function _showDropdown() {
            Menus.closeAll();
            
            $dropdown = $(_renderList(cssFileInfos));
            
            var toggleOffset = $newRuleButton.offset();
            $dropdown
                .css({
                    left: toggleOffset.left,
                    top: toggleOffset.top + $newRuleButton.outerHeight()
                })
                .appendTo($("body"));
            
            $("html").on("click", _closeDropdown);
            
            dropdownEventHandler = new DropdownEventHandler($dropdown, _onSelect, _cleanupDropdown);
            dropdownEventHandler.open();
            
            $dropdown.focus();
        }
        
        /**
         * @private
         * Checks to see if there are any stylesheets in the project, and returns the appropriate
         * "no rules"/"no stylesheets" message accordingly.
         * @return {$.Promise} a promise that is resolved with the message to show. Never rejected.
         */
        function _getNoRulesMsg() {
            var result = new $.Deferred();
            FileIndexManager.getFileInfoList("css").done(function (fileInfos) {
                result.resolve(fileInfos.length ? Strings.CSS_QUICK_EDIT_NO_MATCHES : Strings.CSS_QUICK_EDIT_NO_STYLESHEETS);
            });
            return result;
        }
        
        /**
         * @private
         * Update the enablement of associated menu commands.
         */
        function _updateCommands() {
            _newRuleCmd.setEnabled(cssInlineEditor.hasFocus() && !$newRuleButton.hasClass("disabled"));
        }
        
        /**
         * @private
         * Create a new rule on click.
         */
        function _handleNewRuleClick(e) {
            if (!$newRuleButton.hasClass("disabled")) {
                if (cssFileInfos.length === 1) {
                    // Just go ahead and create the rule.
                    _addRule(selectorName, cssInlineEditor, cssFileInfos[0].fullPath);
                } else if ($dropdown) {
                    _closeDropdown();
                } else {
                    _showDropdown();
                }
            }
            if (e) {
                e.stopPropagation();
            }
        }
        
        CSSUtils.findMatchingRules(selectorName, hostEditor.document)
            .done(function (rules) {
                cssInlineEditor = new MultiRangeInlineEditor.MultiRangeInlineEditor(CSSUtils.consolidateRules(rules),
                                                                                    _getNoRulesMsg, CSSUtils.getRangeSelectors);
                cssInlineEditor.load(hostEditor);
                cssInlineEditor.$htmlContent
                    .on("focusin", _updateCommands)
                    .on("focusout", _updateCommands);

                var $header = $(".inline-editor-header", cssInlineEditor.$htmlContent);
                $newRuleButton = $("<button class='stylesheet-button btn btn-mini disabled'/>")
                    .text(Strings.BUTTON_NEW_RULE)
                    .on("click", _handleNewRuleClick);
                $header.append($newRuleButton);
                _newRuleHandlers.push({inlineEditor: cssInlineEditor, handler: _handleNewRuleClick});
                
                result.resolve(cssInlineEditor);

                // Now that dialog has been built, collect list of stylesheets
                FileIndexManager.getFileInfoList("css")
                    .done(function (fileInfos) {
                        cssFileInfos = fileInfos;
                        
                        // "New Rule" button is disabled by default and gets enabled
                        // here if there are any stylesheets in project
                        if (cssFileInfos.length > 0) {
                            $newRuleButton.removeClass("disabled");
                            if (!rules.length) {
                                // Force focus to the button so the user can create a new rule from the keyboard.
                                $newRuleButton.focus();
                            }
                        }
                        if (cssFileInfos.length > 1) {
                            $newRuleButton.addClass("btn-dropdown");
                        }
                        
                        _updateCommands();
                    });
            })
            .fail(function () {
                console.log("Error in findMatchingRules()");
                result.reject();
            });
        
        return result.promise();
    }

    EditorManager.registerInlineEditProvider(htmlToCSSProvider);
    
    _newRuleCmd = CommandManager.register(Strings.CMD_CSS_QUICK_EDIT_NEW_RULE, Commands.CSS_QUICK_EDIT_NEW_RULE, _handleNewRule);
    _newRuleCmd.setEnabled(false);
});
