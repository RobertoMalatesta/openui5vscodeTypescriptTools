import * as fs from "fs";
import * as ncp from "ncp";
import * as path from "path";
import { ExtensionContext, QuickPickItem, TextDocument, Uri, window, workspace } from "vscode";
import { ui5tsglobal } from "./extension";
import * as file from "./helpers/filehandler";
import * as log from "./helpers/logging";
import { getViewsForController, viewFileEx } from "./language/searchFunctions";
import { Storage } from "./language/xml/XmlDiagnostics";

const namespaceformat = /^(\w+\.?)+\w+$/;
const controllerFileEx = ".controller.{ts,js}";


export async function SetupUi5(): Promise<void> {
    // The code you place here will be executed every time your command is executed

    if (!workspace.rootPath) {
        log.showerror("Cancelling: No Project is opened");
        return;
    }

    const result = await workspace.findFiles("**/manifest.json", null, 1);
    if (result.length > 0) {
        log.showerror("Cancelling: Project is already a UI5 project.");
        return;
    }

    // Get project namespace from user
    const projectnamespace = await window.showInputBox(
        {
            ignoreFocusOut: true,
            placeHolder: "my.ui5.project",
            prompt: "Set default namespace",
            validateInput: (value) => {
                if (value.match(namespaceformat))
                    return null;
                else
                    return "Wrong namespace format!";
            },
        });

    if (!projectnamespace) {
        log.showerror("Cancelling: No project namespace was given.");
        return;
    }

    // Get all project files and copy them to the workspace (with folder structure)
    ncp.ncp(path.join(ui5tsglobal.core.extensionPath, "templates", "project"), workspace.rootPath, (err) => {
        if (err) {
            log.showerror("Error while copying files:'" + err.message + "'");
            return;
        }
        log.printInfo("Files copied.");

        // Search all files for namespace token and replace it with user input
        const replacer = new file.ReplaceInFiles(workspace.rootPath);
        replacer.replaceTokens([{ key: "$(projectNamespace)", value: projectnamespace }]);
    });

    // Display a message box to the user
    log.showinfo("Created new project layout");
}

export async function SwitchToView(): Promise<void> {

    const fullname = ui5tsglobal.core.GetModuleNameFromFilePath(window.activeTextEditor.document.fileName);
    const views = await getViewsForController(fullname);

    if (views.length < 1)
        return;

    if (views.length > 1) {
        window.showInformationMessage("Multiple views found");
        const pick = await window.showQuickPick(views.map(x => x.path.substring(1)));
        window.showTextDocument(await workspace.openTextDocument(pick));
    } else {
        window.showTextDocument(await workspace.openTextDocument(views[0]));
    }
}

interface ISelectFileQuickPickItem extends QuickPickItem {
    controllerName: string;
    fileUri: Uri[];
}

export async function SwitchToController() {
    let views: string[];
    // TODO: Find view with matching controller
    // check if it is a view
    if (path.basename(window.activeTextEditor.document.uri.path).toLowerCase().match(/\.view\.(xml|json)$/)) {
        views = [window.activeTextEditor.document.getText()];
        // it is a fragment
    } else {
        views = await getViewsUsingFragment(ui5tsglobal.core.GetModuleNameFromFilePath(window.activeTextEditor.document.uri.fsPath));
    }

    const files = await getControllersUsedByViews(views);

    if (files.length > 1) {
        const pick = await window.showQuickPick<ISelectFileQuickPickItem>(files.map((value, index, array) => {
            return {
                controllerName: value.controllerName,
                detail: value.fileUri[0].path,
                fileUri: value.fileUri,
                label: value.controllerName,
            } as ISelectFileQuickPickItem;
        }), {
                placeHolder: "Multiple Controllers found. Please select which controller should be used",
            });

        await window.showTextDocument(await workspace.openTextDocument(files[0].fileUri.length < 2 ? files[0].fileUri[0] : files[0].fileUri[1]));
    } else if (files.length > 0) {
        await window.showTextDocument(await workspace.openTextDocument(files[0].fileUri.length < 2 ? files[0].fileUri[0] : files[0].fileUri[1]));
    }
}

async function getViewsUsingFragment(fragmentName: string): Promise<string[]> {
    const views = await workspace.findFiles(ui5tsglobal.core.relativeRootPath + "/**/*" + viewFileEx, undefined);
    const ret: string[] = [];
    for (const view of views) {
        const doc = (await workspace.openTextDocument(view)).getText();
        if (doc.match(new RegExp("fragmentName=([\"'])" + fragmentName + "\\1")))
            ret.push(doc);
    }
    return ret;
}

async function getControllersUsedByViews(viewContents: string[]): Promise<{
    controllerName: string,
    fileUri: Uri[],
}[]> {

    const controllerDictionary: {
        [key: string]: Uri[];
    } = {};

    for (const text of viewContents) {
        const tag = text.match(/controllerName=["']([\w\.]+)["']/);

        if (!tag) {
            continue;
        }

        controllerDictionary[tag[1]] = await workspace.findFiles(ui5tsglobal.core.GetRelativePath(tag[1]) + controllerFileEx, undefined);
    }

    const retlist = [];
    for (const key in controllerDictionary) {
        if (key) {
            retlist.push({
                controllerName: key,
                fileUri: controllerDictionary[key],
            });
        }
    }

    return retlist;
}

export async function AddSchemaToStore(): Promise<void> {
    const context = this as ExtensionContext;
    const filename = await window.showInputBox({ prompt: "Schema location (has to be local .xsd file)", ignoreFocusOut: true });
    // validateInput: (value: string) => {
    //     if(!value.match(/^[a-z]:((\/|(\\?))[\w .]+)+\.xsd$/i))
    //         return "Path is not valid.";
    //     else
    //         return null;
    if (filename.endsWith(".xsd")) {
        fs.createReadStream(filename).pipe(fs.createWriteStream(path.join(context.extensionPath, "schemastore", path.basename(filename))));
        window.showInformationMessage("Successfully added schema to storage.");
    } else {
        const files = fs.readdirSync(filename);
        for (const file of files) {
            fs.createReadStream(path.join(filename, file)).pipe(fs.createWriteStream(path.join(context.extensionPath, "schemastore", path.basename(file))));
        }
        window.showInformationMessage("Successfully added schema to storage.");
    }
    // TODO: Validation
}

export async function AddI18nLabel(label?: string, onSuccess?: () => void) {
    label = label || await window.showInputBox({ prompt: "Name of the label", ignoreFocusOut: true });
    const text = await window.showInputBox({ prompt: "Text the user will see", ignoreFocusOut: true });

    try {
        Storage.i18n.addNewLabel(label, text);
        try {
            if (onSuccess)
                onSuccess();
        } catch (error) {
            // TODO: Create error message on console
        }
    } catch (error) {
        return window.showErrorMessage(error.toString());
    }
}

export async function ResetI18nStorage() {
    Storage.i18n.create();
}
