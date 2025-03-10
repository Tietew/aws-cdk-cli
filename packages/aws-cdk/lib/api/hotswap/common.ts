import type { PropertyDifference, Resource } from '@aws-cdk/cloudformation-diff';
import { ToolkitError } from '../../toolkit/error';
import type { SDK } from '../aws-auth';

export const ICON = '✨';

export interface HotswappableChange {
  readonly hotswappable: true;
  readonly resourceType: string;
  readonly propsChanged: Array<string>;
  /**
   * The name of the service being hotswapped.
   * Used to set a custom User-Agent for SDK calls.
   */
  readonly service: string;

  /**
   * The names of the resources being hotswapped.
   */
  readonly resourceNames: string[];

  readonly apply: (sdk: SDK) => Promise<void>;
}

export interface NonHotswappableChange {
  readonly hotswappable: false;
  readonly resourceType: string;
  readonly rejectedChanges: Array<string>;
  readonly logicalId: string;
  /**
   * Tells the user exactly why this change was deemed non-hotswappable and what its logical ID is.
   * If not specified, `reason` will be autofilled to state that the properties listed in `rejectedChanges` are not hotswappable.
   */
  readonly reason?: string;
  /**
   * Whether or not to show this change when listing non-hotswappable changes in HOTSWAP_ONLY mode. Does not affect
   * listing in FALL_BACK mode.
   *
   * @default true
   */
  readonly hotswapOnlyVisible?: boolean;
}

export type ChangeHotswapResult = Array<HotswappableChange | NonHotswappableChange>;

export interface ClassifiedResourceChanges {
  hotswappableChanges: HotswappableChange[];
  nonHotswappableChanges: NonHotswappableChange[];
}

export enum HotswapMode {
  /**
   * Will fall back to CloudFormation when a non-hotswappable change is detected
   */
  FALL_BACK = 'fall-back',

  /**
   * Will not fall back to CloudFormation when a non-hotswappable change is detected
   */
  HOTSWAP_ONLY = 'hotswap-only',

  /**
   * Will not attempt to hotswap anything and instead go straight to CloudFormation
   */
  FULL_DEPLOYMENT = 'full-deployment',
}

/**
 * Represents a change that can be hotswapped.
 */
export class HotswappableChangeCandidate {
  /**
   * The logical ID of the resource which is being changed
   */
  public readonly logicalId: string;

  /**
   * The value the resource is being updated from
   */
  public readonly oldValue: Resource;

  /**
   * The value the resource is being updated to
   */
  public readonly newValue: Resource;

  /**
   * The changes made to the resource properties
   */
  public readonly propertyUpdates: PropDiffs;

  public constructor(logicalId: string, oldValue: Resource, newValue: Resource, propertyUpdates: PropDiffs) {
    this.logicalId = logicalId;
    this.oldValue = oldValue;
    this.newValue = newValue;
    this.propertyUpdates = propertyUpdates;
  }
}

type Exclude = { [key: string]: Exclude | true };

/**
 * Represents configuration property overrides for hotswap deployments
 */
export class HotswapPropertyOverrides {
  // Each supported resource type will have its own properties. Currently this is ECS
  ecsHotswapProperties?: EcsHotswapProperties;

  public constructor (ecsHotswapProperties?: EcsHotswapProperties) {
    this.ecsHotswapProperties = ecsHotswapProperties;
  }
}

/**
 * Represents configuration properties for ECS hotswap deployments
 */
export class EcsHotswapProperties {
  // The lower limit on the number of your service's tasks that must remain in the RUNNING state during a deployment, as a percentage of the desiredCount
  readonly minimumHealthyPercent?: number;
  // The upper limit on the number of your service's tasks that are allowed in the RUNNING or PENDING state during a deployment, as a percentage of the desiredCount
  readonly maximumHealthyPercent?: number;

  public constructor (minimumHealthyPercent?: number, maximumHealthyPercent?: number) {
    if (minimumHealthyPercent !== undefined && minimumHealthyPercent < 0 ) {
      throw new ToolkitError('hotswap-ecs-minimum-healthy-percent can\'t be a negative number');
    }
    if (maximumHealthyPercent !== undefined && maximumHealthyPercent < 0 ) {
      throw new ToolkitError('hotswap-ecs-maximum-healthy-percent can\'t be a negative number');
    }
    // In order to preserve the current behaviour, when minimumHealthyPercent is not defined, it will be set to the currently default value of 0
    if (minimumHealthyPercent == undefined) {
      this.minimumHealthyPercent = 0;
    } else {
      this.minimumHealthyPercent = minimumHealthyPercent;
    }
    this.maximumHealthyPercent = maximumHealthyPercent;
  }

  /**
   * Check if any hotswap properties are defined
   * @returns true if all properties are undefined, false otherwise
   */
  public isEmpty(): boolean {
    return this.minimumHealthyPercent === 0 && this.maximumHealthyPercent === undefined;
  }
}

/**
 * This function transforms all keys (recursively) in the provided `val` object.
 *
 * @param val The object whose keys need to be transformed.
 * @param transform The function that will be applied to each key.
 * @param exclude The keys that will not be transformed and copied to output directly
 * @returns A new object with the same values as `val`, but with all keys transformed according to `transform`.
 */
export function transformObjectKeys(val: any, transform: (str: string) => string, exclude: Exclude = {}): any {
  if (val == null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    // For arrays we just pass parent's exclude object directly
    // since it makes no sense to specify different exclude options for each array element
    return val.map((input: any) => transformObjectKeys(input, transform, exclude));
  }
  const ret: { [k: string]: any } = {};
  for (const [k, v] of Object.entries(val)) {
    const childExclude = exclude[k];
    if (childExclude === true) {
      // we don't transform this object if the key is specified in exclude
      ret[transform(k)] = v;
    } else {
      ret[transform(k)] = transformObjectKeys(v, transform, childExclude);
    }
  }
  return ret;
}

/**
 * This function lower cases the first character of the string provided.
 */
export function lowerCaseFirstCharacter(str: string): string {
  return str.length > 0 ? `${str[0].toLowerCase()}${str.slice(1)}` : str;
}

export type PropDiffs = Record<string, PropertyDifference<any>>;

export class ClassifiedChanges {
  public constructor(
    public readonly change: HotswappableChangeCandidate,
    public readonly hotswappableProps: PropDiffs,
    public readonly nonHotswappableProps: PropDiffs,
  ) {
  }

  public reportNonHotswappablePropertyChanges(ret: ChangeHotswapResult): void {
    const nonHotswappablePropNames = Object.keys(this.nonHotswappableProps);
    if (nonHotswappablePropNames.length > 0) {
      const tagOnlyChange = nonHotswappablePropNames.length === 1 && nonHotswappablePropNames[0] === 'Tags';
      reportNonHotswappableChange(
        ret,
        this.change,
        this.nonHotswappableProps,
        tagOnlyChange
          ? 'Tags are not hotswappable'
          : `resource properties '${nonHotswappablePropNames}' are not hotswappable on this resource type`,
      );
    }
  }

  public get namesOfHotswappableProps(): string[] {
    return Object.keys(this.hotswappableProps);
  }
}

export function classifyChanges(xs: HotswappableChangeCandidate, hotswappablePropNames: string[]): ClassifiedChanges {
  const hotswappableProps: PropDiffs = {};
  const nonHotswappableProps: PropDiffs = {};

  for (const [name, propDiff] of Object.entries(xs.propertyUpdates)) {
    if (hotswappablePropNames.includes(name)) {
      hotswappableProps[name] = propDiff;
    } else {
      nonHotswappableProps[name] = propDiff;
    }
  }

  return new ClassifiedChanges(xs, hotswappableProps, nonHotswappableProps);
}

export function reportNonHotswappableChange(
  ret: ChangeHotswapResult,
  change: HotswappableChangeCandidate,
  nonHotswappableProps?: PropDiffs,
  reason?: string,
  hotswapOnlyVisible?: boolean,
): void {
  let hotswapOnlyVisibility = true;
  if (hotswapOnlyVisible === false) {
    hotswapOnlyVisibility = false;
  }
  ret.push({
    hotswappable: false,
    rejectedChanges: Object.keys(nonHotswappableProps ?? change.propertyUpdates),
    logicalId: change.logicalId,
    resourceType: change.newValue.Type,
    reason,
    hotswapOnlyVisible: hotswapOnlyVisibility,
  });
}

export function reportNonHotswappableResource(
  change: HotswappableChangeCandidate,
  reason?: string,
): ChangeHotswapResult {
  return [
    {
      hotswappable: false,
      rejectedChanges: Object.keys(change.propertyUpdates),
      logicalId: change.logicalId,
      resourceType: change.newValue.Type,
      reason,
    },
  ];
}
