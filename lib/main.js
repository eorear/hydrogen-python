'use babel';

import { CompositeDisposable, Disposable, Emitter } from 'atom';
import React from "react";
import ReactDOM from "react-dom";
import v4 from "uuid/v4";
import stripIndent from 'strip-indent';
import fs from "fs";
import path from "path";

import VariableExplorer from "./variable-explorer";

// Should be unique among all plugins. At some point, hydrogen should provide
// an API that doesn't require adding fields to the kernel wrappers.
const PLUGIN_KEY = '_nikitakit_python';

const VARIABLE_EXPLORER_URI = 'atom://hydrogen-python/variable-explorer';

function _getUsername() {
  return (
    process.env.LOGNAME ||
    process.env.USER ||
    process.env.LNAME ||
    process.env.USERNAME
  );
}

function createMessageFactory(parent_header) {
  return (type) => {
    return {
      header: {
        username: _getUsername(),
        session: parent_header.session, // check if this is correct
        msg_type: type,
        msg_id: v4(),
        date: new Date(),
        version: "5.0"
      },
      metadata: {},
      parent_header: parent_header,
      content: {}
  }};
}

function codeFromFile(filename) {
  // Takes a file and runs it in a (possibly remote) kernel, while trying not to
  // pollute the kernel's global namespace. We supply all the python files this
  // gets called on, so to avoid escaping issues we mandate that the files not
  // contain ''' anywhere.
  const fullPath = path.join(__dirname, '..', 'py', filename);
  var contents = fs.readFileSync(fullPath, 'utf8');
  if(contents.includes("'''")) {
    throw new Error(`File ${filename} contains triple single-quotes`);
  }

  return `exec('''${contents}''', globals().copy())`
}

class PythonKernelMod {
  constructor(kernel, emitter) {
    this.kernel = kernel;
    this.emitter = emitter;
    this.subscriptions = new CompositeDisposable();

    this.kernel.addMiddleware(this);

    this.kernelPluginInstalled = false;
    this.kernelPluginFailed = false;

    this.enableVariableExplorer = false;
    this.subscriptions.add(
      this.emitter.on('did-show-explorer', ()=>{
        this.enableVariableExplorer = true;
      })
    );
    this.emitter.emit('did-install-middleware');
  }

  execute(next, code, onResults) {
    let makeReply = null;

    // Simple attempt to strip common leading whitespace
    let firstLine = code.split('\n', 1)[0];
    let remainingLines = code.slice(firstLine.length + 1);

    if (remainingLines.length > 0) {
      let rest = stripIndent(remainingLines);
      if (rest != remainingLines) {
        let firstTrimmed = firstLine.trim();
        // Strip leading whitespace, only if first line does not end in ":"
        // XXX(nikita): doesn't handle comments on first line and other edge cases
        if (firstTrimmed.length > 0 && firstTrimmed[firstTrimmed.length - 1] != ":") {
            code = firstLine + "\n" + rest;
        }
      }
    }

    next.execute(code, (msg, channel) => {
      if (!makeReply && msg.parent_header) {
        makeReply = createMessageFactory(msg.parent_header);
      }

      onResults(msg, channel);
      if (msg.header.msg_type == "execute_reply") {
        if (this.enableVariableExplorer){
          this.variableExplorerHook(next);
        }
      }
    });
  }

  shutdown(next) {
    next.shutdown();

    this.kernelPluginInstalled = false;
    this.kernelPluginFailed = false;
    this.emitter.emit('did-update-vars', []);
  }

  restart(next, onRestarted) {
    next.restart(onRestarted);

    this.kernelPluginInstalled = false;
    this.kernelPluginFailed = false;
    this.emitter.emit('did-update-vars', []);
  }

  wrapDataHandler(dataHandler) {
    return (msg, channel) => {
      if (channel === "iopub"
        && msg.header.msg_type === "display_data"
        && msg.content.data
        && msg.content.data['application/json']
        && msg.content.data['application/json'].hydrogen_python) {
          dataHandler(msg.content.data['application/json'].hydrogen_python);
      }
    }
  }

  startKernelPluginInstall(next, onInstalled) {
    this.kernelPluginFailed = true;
    const sanityCode = codeFromFile('sanity_check.py');
    const installCode = codeFromFile('install_kernel_plugin.py');
    next.execute(sanityCode, this.wrapDataHandler((data) => {
      if (data !== "pass") {
        return;
      }
      next.execute(installCode, this.wrapDataHandler((data) => {
        console.log("hydrogen-python: kernel plugin installed");
        this.kernelPluginInstalled = true;
        this.kernelPluginFailed = false;
        if (onInstalled) {
          onInstalled(next);
        }
      }));
    }));
  }

  variableExplorerHook(next) {
    if (this.kernelPluginFailed) {
      return;
    }

    if (!this.kernelPluginInstalled) {
      this.startKernelPluginInstall(next, this.variableExplorerHook.bind(this));
      return;
    }

    next.execute("get_ipython()._hydrogen_python.run('variable_explorer_hook')",
      this.wrapDataHandler((data) => {
        if (data.error) {
          console.error(data.error);
        }
        if (data.variables) {
          this.emitter.emit('did-update-vars', data.variables);
        }
      }));
  }
}

const HydrogenPythonPlugin = {
  subscriptions: null,
  hydrogen: null,
  emitter: null,

  activate() {
    this.subscriptions = new CompositeDisposable();

    this.emitter = new Emitter();
    this.subscriptions.add(this.emitter);

    this.subscriptions.add(
      atom.workspace.addOpener(uri =>  {
        switch(uri) {
          case VARIABLE_EXPLORER_URI:
            return new VariableExplorerPane(this.emitter);
        }
      }),
      // Destroy any Panes when the package is deactivated.
      new Disposable(() => {
        atom.workspace.getPaneItems().forEach(item => {
          if (item instanceof VariableExplorer) {
            item.destroy();
          }
        });
      })
    );

    this.subscriptions.add(
      atom.commands.add("atom-text-editor:not([mini])", {
        "hydrogen-python:toggle-variable-explorer": () =>
          atom.workspace.toggle(VARIABLE_EXPLORER_URI),
      })
    );
  },

  deactivate() {
    this.subscriptions.dispose();
  },

  consumeHydrogen(hydrogen) {
    this.hydrogen = hydrogen;

    this.hydrogen.onDidChangeKernel(kernel => {
      if (kernel && kernel.language === "python" && !kernel[PLUGIN_KEY]) {
        let kernelMod = new PythonKernelMod(kernel, this.emitter);
        kernel[PLUGIN_KEY] = {mod: kernelMod};
      }
    });

    return new Disposable(() => {
      this.hydrogen = null;
    });
  },
};

class VariableExplorerPane {
  reactElement = null;
  element = document.createElement("div");
  subscriptions = new CompositeDisposable();

  constructor(emitter) {
    const reactElement = <VariableExplorer emitter={emitter} />

    ReactDOM.render(reactElement, this.element);
    this.subscriptions.add(new Disposable(() => {
      ReactDOM.unmountComponentAtNode(this.element);
    }));

    emitter.emit('did-show-explorer');
    this.subscriptions.add(
      emitter.on('did-install-middleware', ()=>{
        emitter.emit('did-show-explorer');
      })
    );
  }

  getTitle = () => "Variable Explorer";

  getURI = () => VARIABLE_EXPLORER_URI;

  getDefaultLocation = () => "right";

  getAllowedLocations = () => ["left", "right", "bottom"];

  destroy() {
    this.subscriptions.dispose();
    this.element.remove();
  }
}

export default HydrogenPythonPlugin;
