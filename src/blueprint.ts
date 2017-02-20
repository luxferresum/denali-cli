import {
  template,
  forEach,
  merge,
  assign,
  intersection,
  mapKeys,
  keys
} from 'lodash';
import * as path from 'path';
import * as fs from 'fs';
import * as chalk from 'chalk';
import * as walk from 'walk-sync';
import codeshift from 'jscodeshift';
import * as mkdirp from 'mkdirp';
import * as rimraf from 'rimraf';
import * as yargs from 'yargs';
import requireTree = require('require-tree');
import { sync as isDirectory } from 'is-directory';
import Project from './project';
import { Options as YargsOptions } from 'yargs';
import ui from './ui';
import findAddons from './find-addons';
import Command from './command';
import * as argParser from 'yargs';
import * as createDebug from 'debug';
import * as tryRequire from 'try-require';

const debug = createDebug('denali-cli:blueprint');

/**
 * The Blueprint class manages generating code from a template, or "blueprint". Blueprints have
 * three main parts:
 *
 * - The `locals()` hook, used to generate data to fill in the the templates
 *
 * - Templates, found under `<blueprint dir>/files`. These files are copied over into the project.
 *   The can contain ERB style interpolation to inject values from the `locals` data. Filenames can
 *   also contain variables, delimited by `__variable__`
 *
 * - The `postInstall()` hook, which runs after the copying operation is finished. This gives the
 *   blueprint a chance to perform additional steps that simple templating can't support (i.e.
 *   install an node module).
 *
 * The code generated by a blueprint can also be removed via the `destroy` command. That command
 * will only remove files that exactly match the what the blueprint generates, so if you modify a
 * file after it was generated, it won't be removed.
 *
 * @module denali-cli
 */
export default class Blueprint extends Command {

  /**
   * Convenience method for calling `.findBlueprints()` and then `.configureBlueprints()`
   */
  public static findAndConfigureBlueprints(yargs: yargs.Argv, context: { isLocal: boolean, name: string, action?: 'generate' | 'destroy' }) {
    let blueprints = this.findBlueprints(context.isLocal);
    return this.configureBlueprints(blueprints, yargs, context);
  }

  /**
   * Find all available blueprints
   */
  public static findBlueprints(isLocal: boolean) {
    let blueprints: { [name: string]: typeof Blueprint } = {};
    let addons = findAddons(isLocal);
    debug('discovering available blueprints');
    addons.forEach((addon) => {
      this.discoverBlueprintsForAddon(blueprints, addon.pkg.name, path.join(addon.dir, 'blueprints'));
    });
    return blueprints;
  }

  /**
   * Given a set of blueprints and a yargs instance, given each blueprint the chance to add a
   * command to the yargs instance for itself
   */
  public static configureBlueprints(blueprints: { [name: string]: typeof Blueprint }, yargs: yargs.Argv, context: { isLocal: boolean, name: string, action?: 'generate' | 'destroy' }) {
    // Configure a yargs instance with a command for each one
    forEach(blueprints, (BlueprintClass: typeof Blueprint, name: string): void => {
      try {
        debug(`configuring ${ BlueprintClass.blueprintName } blueprint (invocation: "${ name }")`);
        yargs = BlueprintClass.configure(yargs, merge({}, context, { name }));
      } catch (error) {
        ui.warn(`${ name } blueprint failed to configure itself:`);
        ui.warn(error.stack);
      }
    });
    return yargs;
  }

  /**
   * Given an addon's name and source directory, load all the blueprints that addon may supply
   */
  public static discoverBlueprintsForAddon(blueprintsSoFar: { [blueprintName: string]: typeof Blueprint }, addonName: string, dir: string) {
    if (!fs.existsSync(dir)) {
      return {};
    }
    // Load the blueprints
    let Blueprints = fs.readdirSync(dir)
      .filter((dirname) => isDirectory(path.join(dir, dirname)))
      .reduce<{ [key: string]: typeof Blueprint }>((BlueprintsSoFar, dirname: string) => {
        let BlueprintClass = tryRequire(path.join(dir, dirname));
        BlueprintClass.addon = addonName;
        BlueprintsSoFar[dirname] = BlueprintClass.default || BlueprintClass;
        return BlueprintsSoFar;
      }, {});
    // Capture the source directory of the blueprint
    forEach(Blueprints, (BlueprintClass, blueprintDir) => {
      BlueprintClass.dir = path.join(dir, blueprintDir);
    });
    // Then use the blueprintName as the invocation name, if provided (otherwise, fallback to the
    // directory name
    Blueprints = mapKeys(Blueprints, (BlueprintClass, blueprintDir) => BlueprintClass.blueprintName || blueprintDir);
    debug(`found ${ keys(Blueprints).length } blueprints for ${ addonName }: [ ${ keys(Blueprints).join (', ') } ]`);
    // Move any already-loaded blueprints with the same name as these new ones under an addon-scoped
    // namespace
    intersection(keys(Blueprints), keys(blueprintsSoFar)).forEach((collidingBlueprintName: string) => {
      let clobberedBlueprint = blueprintsSoFar[collidingBlueprintName];
      blueprintsSoFar[clobberedBlueprint.addon + ':' + collidingBlueprintName] = clobberedBlueprint;
    });
    // Also create a map with the blueprint names scoped to the addon name
    return assign(blueprintsSoFar, Blueprints);
  }

  /**
   * Customize the subcommands header to indicate that it's a list of blueprints
   */
  public static configure(yargs: yargs.Argv, context: { name: string, isLocal: boolean }): yargs.Argv {
    return super.configure(yargs, context)
      .updateStrings({
        'Commands:': 'Available Blueprints:'
      });
  }

  /**
   * The name used to invoke this blueprint.
   */
  public static blueprintName: string;

  /**
   * The source directory for this blueprints
   */
  public static dir: string;

  /**
   * Should we generate or destroy this blueprint?
   */
  public action: 'generate' | 'destroy';

  /**
   * Immediately delegates to either generate or destroy
   */
  public async run(argv: any) {
    if (this.action === 'generate') {
      await  this.generate(argv);
    } else {
      await this.destroy(argv);
    }
  }

  /**
   * Generate the blueprint. Generates the data to interpolate into the templates, then copies the
   * template files over into the project. Finally, runs the postInstall hook.
   */
  public async generate(argv: any): Promise<void> {
    let data = this.locals(argv);
    let dest = process.cwd();

    walk(this.templateFiles).forEach((relativepath: string): void => {
      let absolutepath = path.resolve(path.join(this.templateFiles, relativepath));
      if (isDirectory(absolutepath)) {
        return null;
      }

      let filenameTemplate = template(relativepath, {
        interpolate: /__([\S]+)__/g,
        sourceURL: relativepath
      });
      let destRelativepath = filenameTemplate(data);
      let destAbsolutepath = path.join(dest, destRelativepath);

      if (fs.existsSync(destAbsolutepath)) {
        ui.info(`${ chalk.green('already exists') } ${ destRelativepath }`);
        return;
      }

      let contents = fs.readFileSync(absolutepath, 'utf-8');
      let contentsTemplate = template(contents, {
        interpolate: /<%=([\s\S]+?)%>/g,
        sourceURL: relativepath
      });
      mkdirp.sync(path.dirname(destAbsolutepath));
      fs.writeFileSync(destAbsolutepath, contentsTemplate(data));
      ui.info(`${ chalk.green('create') } ${ destRelativepath }`);
    });

    try {
      await this.postInstall(argv);
    } catch (e) {
      ui.error('postInstall failed:');
      ui.error(e.stack || e);
    }
  }

  /**
   * Destroy the blueprint. Generates the data to interpolate into the templates, then deletes any
   * unmodified files that were generated by this blueprint. Then runs the postUninstall hook.
   */
  public async destroy(argv: any): Promise<void> {
    let data = this.locals(argv);
    let dest = process.cwd();

    let filesToDelete: string[] = [];
    walk(this.templateFiles).forEach((relativepath: string) => {
      return filesToDelete.push(path.resolve(path.join(this.templateFiles, relativepath)));
    });

    // Get the absolute paths for the template source file and the dest file
    filesToDelete = filesToDelete.map((absolutepath) => {
      let relativepath = path.relative(this.templateFiles, absolutepath);
      let filenameTemplate = template(relativepath, { interpolate: /__([\S]+)__/g });
      let destRelativepath = filenameTemplate(data);
      let destAbsolutepath = path.join(dest, destRelativepath);
      return { destAbsolutepath, destRelativepath, absolutepath };

    // Ensure that the dest file actually exists
    }).filter(({ destAbsolutepath, destRelativepath, absolutepath }) => {
      if (isDirectory(absolutepath)) {
        return false;
      }
      let fileExists = fs.existsSync(destAbsolutepath);
      if (!fileExists) {
        ui.info(`${ chalk.grey('missing') } ${ destRelativepath }`);
      }
      return fileExists;

    // And either hasn't been altered, or the force option is being used, to ensure we don't destroy
    // code
    }).filter(({ destAbsolutepath, absolutepath, destRelativepath }) => {
      let templateSrc = fs.readFileSync(absolutepath, 'utf-8');
      let compiled = template(templateSrc);
      let destFileIsNotDirty = fs.readFileSync(destAbsolutepath, 'utf-8') === compiled(data);

      if (destFileIsNotDirty) {
        ui.info(`${ chalk.red('destroy') } ${ destRelativepath }`);
      } else {
        ui.info(`${ chalk.blue('skipped') } ${ destRelativepath }`);
      }

      return destFileIsNotDirty;
    }).map(({ destAbsolutepath }) => {
      return destAbsolutepath;
    });

    filesToDelete.forEach((file) => {
      rimraf.sync(file);
    });
    await this.postUninstall(argv);
  }

  /**
   * A hook to generate data to be interpolated into the blueprint's template files.
   */
  public locals(argv: any): any {
    return {};
  }

  /**
   * Runs after the templating step is complete, letting you make additional modifications (i.e.
   * install a node module).
   */
  public async postInstall(argv: any): Promise<void> { /* noop by default */ }

  /**
   * Runs when `denali destroy` is invoked, after the applicable template files have been removed.
   * You should clean up / reverse any changes made in postInstall(), but only in a way that avoids
   * removing user modifications.
   */
  public async postUninstall(argv: any): Promise<void> { /* noop by default */ }

  /**
   * Returns the path to this blueprints template files directory. Defaults to `files/`.
   */
  public get templateFiles(): string {
    return path.join((<typeof Blueprint>this.constructor).dir, 'files');
  }

  /**
   * Adds a route to this package's router.
   */
  public addRoute(method: string, urlPattern: string, actionPath?: string, ...args: any[]): void {
    let routesFilepath = path.join(process.cwd(), 'config', 'routes.js');
    let routesSource = fs.readFileSync(routesFilepath, 'utf-8');
    let j = codeshift;
    let ast = codeshift(routesSource);
    let drawRoutesFunction = ast.find(j.ExportDefaultDeclaration).get().value.declaration;
    let routerArgName = drawRoutesFunction.params[0].name;
    let drawRoutesFunctionBody = j(drawRoutesFunction.body);
    let duplicate = drawRoutesFunctionBody.find(j.ExpressionStatement, {
      expression: {
        callee: {
          object: { name: routerArgName },
          property: { name: method }
        },
        arguments: [ urlPattern, actionPath ].concat(args).map((arg) => {
          return { value: arg };
        })
      }
    });
    if (duplicate.length > 0) {
      return;
    }
    let routerInvocations = drawRoutesFunctionBody.find(j.ExpressionStatement, {
      expression: {
        callee: {
          object: { name: routerArgName }
        }
      }
    });
    let lastRouterInvocation = routerInvocations.at(routerInvocations.length - 1);
    let routerMethodExpression = j.memberExpression(j.identifier(routerArgName), j.identifier(method));
    let routerArguments = args.map((arg) => j.stringLiteral(arg));
    let routerMethodInvocation = j.callExpression(routerMethodExpression, routerArguments);
    let newRoute = j.expressionStatement(routerMethodInvocation);
    lastRouterInvocation.insertAfter(newRoute);
    fs.writeFileSync(routesFilepath, ast.toSource({ quote: 'single' }));
  }

  /**
   * Removes a route from this package's router
   */
  public removeRoute(method: string, urlPattern: string, actionPath?: string, ...args: any[]): void {
    let routesFilepath = path.join(process.cwd(), 'config', 'routes.js');
    let routesSource = fs.readFileSync(routesFilepath, 'utf-8');
    let j = codeshift;
    let ast = codeshift(routesSource);
    let drawRoutesFunction = ast.find(j.ExportDefaultDeclaration).get().value.declaration;
    let routerArgName = drawRoutesFunction.params[0].name;
    let drawRoutesFunctionBody = j(drawRoutesFunction.body);
    drawRoutesFunctionBody.find(j.ExpressionStatement, {
      expression: {
        callee: {
          object: { name: routerArgName },
          property: { name: method }
        },
        arguments: [ urlPattern, actionPath ].concat(args).map((arg) => {
          return { value: arg };
        })
      }
    }).remove();
    fs.writeFileSync(routesFilepath, ast.toSource());
  }

}
